import { Context, Hono } from "hono";
import { validate } from "@/lib/validation/validator";
import { error, success } from "@/lib/response";
import { Code } from "@/lib/code";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import {
    TagCreateBodySchema,
    TagListQuerySchema,
    TagMergeBodySchema,
    TagUpdateBodySchema,
} from "@/features/tag/schema";
import { TagError } from "@/features/tag/errors";
import { createTag, deleteTag, listTags, mergeTags, updateTag } from "@/features/tag/tag-service";

const router = new Hono<AuthEnv>();

function getTagAuth(c: Context<AuthEnv>) {
    const user = c.get("user");
    if (!user) return null;

    return {
        ownerId: user.id,
        scopedLibraryId: c.get("apiToken")?.library_id,
    };
}

function handleTagError(c: Context<AuthEnv>, cause: unknown): Response {
    if (cause instanceof TagError) {
        if (cause.kind === "FORBIDDEN") {
            return c.json(error(Code.FORBIDDEN, cause.message), 403);
        }
        if (cause.kind === "NOT_FOUND") {
            return c.json(error(Code.NOT_FOUND, cause.message), 404);
        }
        if (cause.kind === "CONFLICT") {
            return c.json(error(Code.ALREADY_EXISTS, cause.message), 400);
        }
        return c.json(error(Code.INVALID_PARAMETER, cause.message), 400);
    }

    const message = cause instanceof Error ? cause.message : String(cause);
    return c.json(error(Code.INTERNAL_SERVER_ERROR, message), 500);
}

router.get("/list", requireAuth, validate("query", TagListQuerySchema), async (c) => {
    const auth = getTagAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await listTags(c.req.valid("query"), auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleTagError(c, cause);
    }
});

router.post("/create", requireAuth, validate("json", TagCreateBodySchema), async (c) => {
    const auth = getTagAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await createTag(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleTagError(c, cause);
    }
});

router.post("/update", requireAuth, validate("json", TagUpdateBodySchema), async (c) => {
    const auth = getTagAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        const result = await updateTag(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleTagError(c, cause);
    }
});

router.post("/delete/:id", requireAuth, async (c) => {
    const auth = getTagAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const tagId = c.req.param("id");
    if (!tagId) {
        return c.json(error(Code.INVALID_PARAMETER, "Tag ID is required"), 400);
    }

    try {
        const result = await deleteTag(tagId, auth);
        return c.json(success(Code.SUCCESS, result));
    } catch (cause) {
        return handleTagError(c, cause);
    }
});

router.post("/merge", requireAuth, validate("json", TagMergeBodySchema), async (c) => {
    const auth = getTagAuth(c);
    if (!auth) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    try {
        await mergeTags(c.req.valid("json"), auth);
        return c.json(success(Code.SUCCESS, null, "Tags merged successfully"));
    } catch (cause) {
        return handleTagError(c, cause);
    }
});

export default router;
