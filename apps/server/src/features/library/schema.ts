import * as v from "valibot";

const uniqueIds = (ids: string[]) => Array.from(new Set(ids));

export const LibraryMoveItemsBodySchema = v.pipe(
    v.strictObject({
        post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid post ID format"))), []),
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid media ID format"))), []),
        target_library_id: v.pipe(v.string(), v.uuid("Invalid target_library_id format")),
    }),
    v.check((body) => body.post_ids.length > 0 || body.media_ids.length > 0, "At least one post or media id is required"),
    v.transform((data) => ({
        target_library_id: data.target_library_id,
        post_ids: uniqueIds(data.post_ids),
        media_ids: uniqueIds(data.media_ids),
    })),
);

export type LibraryMoveItemsInput = v.InferOutput<typeof LibraryMoveItemsBodySchema>;
