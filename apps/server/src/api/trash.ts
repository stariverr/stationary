import { Hono } from "hono";
import * as v from "valibot";
import { AuthEnv, ownedLibrary, requireAuth } from "@/lib/auth/middleware";
import { validate } from "@/lib/validation/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import { TrashService } from "@/features/trash/trash-service";

const router = new Hono<AuthEnv>();

export const TrashListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
    type: v.optional(v.picklist(["all", "post", "media"]), "all"),
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
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(100))),
        ),
        20,
    ),
    keyword: v.optional(v.string()),
    sort_by: v.optional(v.picklist(["recycle_time"]), "recycle_time"),
    sort_order: v.optional(v.picklist(["asc", "desc"]), "desc"),
});

export const TrashBatchActionSchema = v.pipe(
    v.object({
        library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
        post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid post ID format")))),
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid media ID format")))),
    }),
    v.check(
        (data) => (data.post_ids?.length || 0) + (data.media_ids?.length || 0) > 0,
        "Either post_ids or media_ids must be provided and cannot be empty",
    ),
);

export const TrashEmptySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID format")),
});

/**
 * List all items in the recycle bin for a given library.
 */
router.get("/list", requireAuth, validate("query", TrashListQuerySchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id, type, page, count, keyword, sort_by, sort_order } = c.req.valid("query");

    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const result = await TrashService.listTrashItems({
        libraryId: library_id,
        type,
        keyword,
        page,
        count,
        sortBy: sort_by,
        sortOrder: sort_order,
    });

    return c.json(
        success(Code.SUCCESS, {
            list: result.list,
            total: result.total,
            page,
            count,
        }),
    );
});

/**
 * Batch restore posts and media from the recycle bin.
 */
router.post("/restore", requireAuth, validate("json", TrashBatchActionSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id, post_ids, media_ids } = c.req.valid("json");

    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const result = await TrashService.batchRestore({
        library,
        postIds: post_ids,
        mediaIds: media_ids,
    });

    return c.json(success(Code.SUCCESS, result));
});

/**
 * Batch permanently delete posts and media from the recycle bin.
 */
router.post("/delete", requireAuth, validate("json", TrashBatchActionSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id, post_ids, media_ids } = c.req.valid("json");

    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const result = await TrashService.batchDelete({
        libraryId: library_id,
        postIds: post_ids,
        mediaIds: media_ids,
    });

    return c.json(success(Code.SUCCESS, result));
});

/**
 * Empty the entire recycle bin for a library.
 */
router.post("/empty", requireAuth, validate("json", TrashEmptySchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id } = c.req.valid("json");

    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const result = await TrashService.emptyTrash(library_id);

    return c.json(success(Code.SUCCESS, result));
});

export default router;
