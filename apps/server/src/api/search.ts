import { Hono } from "hono";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { HybridSearchService } from "@/services/ai/search";
import { MediaType, PostSource } from "@/db/schema";

const router = new Hono<AuthEnv>();

// Search must be authenticated to enforce user access library boundary constraints
router.use("*", requireAuth);

export const SearchQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library_id format")),
    keyword: v.pipe(v.string(), v.trim()),
    source: v.optional(v.enum(PostSource)),
    media_type: v.optional(v.enum(MediaType)),
    page: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        ),
        1,
    ),
    count: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
        ),
        20,
    ),
});

router.get(
    "/",
    validate("query", SearchQuerySchema),
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
            return c.json(error(Code.INTERNAL_SERVER_ERROR, err.message || "An unexpected error occurred during search."), 500);
        }
    },
);

export default router;
