import { Hono } from "hono";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { ApiTokenService } from "@/services/apiToken";

const router = new Hono<AuthEnv>();

router.use("*", requireAuth);

router.get("/", (c) => {
    const user = c.get("user");
    const authUser = c.get("authUser");
    return c.json(
        success(Code.SUCCESS, {
            ...user,
            email: authUser?.email || null,
        }),
    );
});

export const TokenCreateBodySchema = v.strictObject({
    name: v.pipe(v.string(), v.nonEmpty("Name is required")),
    library_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid("Invalid library_id format")))),
    expires_in_seconds: v.optional(
        v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1, "expires_in_seconds must be positive"))),
    ),
});

// Create a new API token
router.post(
    "/tokens",
    validate("json", TokenCreateBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
        const body = c.req.valid("json");

        const result = await ApiTokenService.generateToken(user.id, body.name, body.library_id, body.expires_in_seconds);

        return c.json(
            success(Code.SUCCESS, {
                id: result.token.id,
                name: result.token.name,
                prefix: result.token.prefix,
                first_four: result.token.first_four,
                last_four: result.token.last_four,
                token: result.rawToken,
                library_id: result.token.library_id,
                expires_at: result.token.expire_time,
                create_time: result.token.create_time,
            }),
        );
    },
);

// List all active tokens
router.get("/tokens", async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const tokens = await ApiTokenService.listTokens(user.id);

    // Return token metadata (omitting token_hash for security)
    const list = tokens.map((t) => ({
        id: t.id,
        name: t.name,
        prefix: t.prefix,
        first_four: t.first_four,
        last_four: t.last_four,
        library_id: t.library_id,
        last_used_at: t.last_use_time,
        expires_at: t.expires_at,
        create_time: t.create_time,
    }));

    return c.json(success(Code.SUCCESS, list));
});

// Revoke an API token
router.delete("/tokens/:id", async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "Token ID is required"), 400);
    }

    const revoked = await ApiTokenService.revokeToken(id, user.id);
    if (!revoked) {
        return c.json(error(Code.NOT_FOUND, "Token not found or already revoked"), 404);
    }

    return c.json(success(Code.SUCCESS, { id }, "Token revoked successfully"));
});

export default router;
