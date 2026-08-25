import * as v from "valibot";
import { MediaDraftSchema } from "@/lib/validation/media-composition";

export const PresignDraftSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    fileName: v.pipe(v.string(), v.nonEmpty("fileName is required")),
});

export const ConfirmDraftSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    draft_file_id: v.pipe(v.string(), v.uuid()),
    fileName: v.pipe(v.string(), v.nonEmpty("fileName is required")),
    path: v.pipe(v.string(), v.nonEmpty()),
    bucket: v.pipe(v.string(), v.nonEmpty()),
    mime_type: v.pipe(v.string(), v.nonEmpty()),
    size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    upload_token: v.pipe(v.string(), v.nonEmpty()),
});

export const CommitMediaSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    media_drafts: v.pipe(v.array(MediaDraftSchema), v.minLength(1, "At least one media group is required")),
});

export type PresignDraftInput = v.InferOutput<typeof PresignDraftSchema>;
export type ConfirmDraftInput = v.InferOutput<typeof ConfirmDraftSchema>;
export type CommitMediaInput = v.InferOutput<typeof CommitMediaSchema>;
