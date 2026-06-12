import { Hono } from "hono";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { z } from "zod";
import { validator } from "hono/validator";
import { HybridSearchService } from "@/services/ai/search";
import { MediaType, PostSource } from "@/db/schema";

const router = new Hono<AuthEnv>();

// Search must be authenticated to enforce user access library boundary constraints
router.use("*", requireAuth);

export const SearchQuerySchema = z.object({
    library_id: z.uuid("Invalid library_id format"),
    keyword: z.string().trim(),
    source: z.enum(PostSource).optional(),
    media_type: z.enum(MediaType).optional(),
    page: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1).optional().default(1),
    ),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1).lte(100).optional().default(20),
    ),
});

router.get(
    "/",
    validator("query", (value, c) => {
        const parsed = SearchQuerySchema.safeParse(value);
        if (!parsed.success) {
            return c.json(
                error(
                    Code.INVALID_PARAMETER,
                    parsed.error.issues[0]?.message || "Invalid search query parameters",
                ),
                400,
            );
        }
        return parsed.data;
    }),
    async (c) => {
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }

        const queryParams = c.req.valid("query");

        try {
            const results = await HybridSearchService.search(
                {
                    keyword: queryParams.keyword,
                    library_id: queryParams.library_id,
                    source: queryParams.source,
                    media_type: queryParams.media_type,
                    page: queryParams.page,
                    count: queryParams.count,
                },
                user.id,
            );

            return c.json(success(Code.SUCCESS, results));
        } catch (err: any) {
            console.error(`[API SEARCH ERROR]`, err);
            return c.json(
                error(
                    Code.INTERNAL_SERVER_ERROR,
                    err.message || "An unexpected error occurred during search.",
                ),
                500,
            );
        }
    },
);

export default router;
