import * as v from "valibot";
import { MediaDraftSchema } from "@/lib/validation/media-composition";

const CreatePostMediaItemSchema = v.variant("kind", [
    v.object({
        kind: v.literal("existing"),
        media_id: v.pipe(v.string(), v.uuid()),
    }),
    v.object({
        kind: v.literal("draft"),
        draft: MediaDraftSchema,
    }),
]);

export const CreatePostSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    title: v.pipe(v.string(), v.nonEmpty("Title is required")),
    description: v.optional(v.string(), ""),
    tag_ids: v.optional(v.array(v.pipe(v.string(), v.uuid())), []),
    media_items: v.optional(v.array(CreatePostMediaItemSchema)),
});

export type CreatePostInput = v.InferOutput<typeof CreatePostSchema>;
