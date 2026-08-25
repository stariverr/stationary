import * as v from "valibot";
import { TrackDraftSchema } from "@/lib/validation/media-composition";

export const AddTracksFromDraftSchema = v.object({
    tracks: v.pipe(v.array(TrackDraftSchema), v.minLength(1)),
});

export type AddTracksFromDraftInput = v.InferOutput<typeof AddTracksFromDraftSchema>;
