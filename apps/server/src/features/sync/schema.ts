import * as v from "valibot";

export const RetrySyncSchema = v.pipe(
    v.object({
        post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    }),
    v.check((input) => Boolean(input.post_ids?.length || input.media_ids?.length), "At least one post_id or media_id is required"),
);

export type RetrySyncInput = v.InferOutput<typeof RetrySyncSchema>;
