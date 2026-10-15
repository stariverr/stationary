import * as v from "valibot";
import { isSupportedLanguage } from "./image-metadata";
import { LibraryAiBindingsSchema } from "./model-schema";

export const QueueAiSchema = v.pipe(
    v.object({
        post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    }),
    v.check((input) => Boolean(input.post_ids?.length || input.media_ids?.length), "At least one post_id or media_id is required"),
);

export type QueueAiInput = v.InferOutput<typeof QueueAiSchema>;

/** Body of `POST /api/ai/bindings/:library_id`: every role binding plus library-level AI options. */
export const UpdateLibraryAiBindingsSchema = v.object({
    ...LibraryAiBindingsSchema.entries,
    /** BCP 47 language for image descriptions. */
    language: v.optional(v.pipe(v.string(), v.check(isSupportedLanguage, "Unsupported language"))),
});
