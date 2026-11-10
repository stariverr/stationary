/**
 * The draft shape of a media the user uploads, and the checks that can run before its files are probed. What the
 * originals actually hold is checked against the composition rules after probing (features/media/originals.ts).
 */
import * as v from "valibot";
import { MediaType } from "@/db/schema";
import { getFileCategories, type FileCategory } from "@/lib/utils/file";

/** Media types that can have a cover: one image, uploaded or imported, that their previews are rendered from. */
export const COVER_MEDIA_TYPES: ReadonlySet<MediaType> = new Set([MediaType.VIDEO, MediaType.AUDIO, MediaType.PDF]);

/** Media types that can have captions. */
export const CAPTION_MEDIA_TYPES: ReadonlySet<MediaType> = new Set([MediaType.VIDEO, MediaType.AUDIO]);

const DraftFileIdSchema = v.pipe(v.string(), v.uuid());

export const CaptionDraftSchema = v.object({
    draft_file_id: DraftFileIdSchema,
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    is_default: v.optional(v.boolean(), false),
});

export const MediaDraftSchema = v.object({
    title: v.optional(v.string(), ""),
    description: v.optional(v.string(), ""),
    type: v.enum(MediaType),
    tag_ids: v.optional(v.array(v.pipe(v.string(), v.uuid())), []),
    /** The files of the media as uploaded, e.g. a video and separate audio files. */
    originals: v.pipe(v.array(DraftFileIdSchema), v.minLength(1, "Each media must have at least one original")),
    cover: v.optional(v.nullable(DraftFileIdSchema), null),
    captions: v.optional(v.array(CaptionDraftSchema), []),
});

export type MediaDraft = v.InferOutput<typeof MediaDraftSchema>;

/** What each original of a media type may be, judged from its file name before it is probed. */
const ORIGINAL_CATEGORIES: Record<MediaType, FileCategory[]> = {
    [MediaType.IMAGE]: ["IMAGE"],
    [MediaType.VIDEO]: ["VIDEO", "AUDIO"],
    [MediaType.AUDIO]: ["AUDIO", "VIDEO"],
    [MediaType.LIVE_PHOTO]: ["IMAGE", "VIDEO"],
    [MediaType.PDF]: ["PDF"],
};

/** The draft files of a media, in the order the draft lists them. */
export function draftFileIds(draft: Pick<MediaDraft, "originals" | "cover" | "captions">): string[] {
    return [...draft.originals, ...(draft.cover ? [draft.cover] : []), ...draft.captions.map((caption) => caption.draft_file_id)];
}

/**
 * Checks a draft against what its file names allow: originals of a fitting kind, a cover only where covers exist and
 * only as an image, captions only on audio and video, at most one default caption.
 */
export function draftStructureError(draft: MediaDraft, fileName: (draftFileId: string) => string | undefined): string | null {
    const fits = (draftFileId: string, allowed: FileCategory[]) => {
        const name = fileName(draftFileId);
        return name !== undefined && getFileCategories(name).some((category) => allowed.includes(category));
    };
    const misfit = draft.originals.find((id) => !fits(id, ORIGINAL_CATEGORIES[draft.type]));
    if (misfit) return `${fileName(misfit) ?? misfit} cannot be an original of ${draft.type} media`;
    if (draft.cover) {
        if (!COVER_MEDIA_TYPES.has(draft.type)) return `${draft.type} media cannot have a cover`;
        if (!fits(draft.cover, ["IMAGE"])) return "A cover must be an image";
    }
    if (draft.captions.length > 0 && !CAPTION_MEDIA_TYPES.has(draft.type)) return `${draft.type} media cannot have captions`;
    const notCaption = draft.captions.find((caption) => !fits(caption.draft_file_id, ["SUBTITLE"]));
    if (notCaption) return `${fileName(notCaption.draft_file_id) ?? notCaption.draft_file_id} is not a caption file`;
    if (draft.captions.filter((caption) => caption.is_default).length > 1) return "Only one caption can be the default";
    return null;
}

/** Checks the drafts of one request: no draft file used twice, and each draft well formed. */
export function validateDraftMediaGroups(drafts: MediaDraft[], fileName: (draftFileId: string) => string | undefined): string | null {
    const ids = drafts.flatMap(draftFileIds);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) return `Draft file ${duplicate} is used more than once`;
    for (const draft of drafts) {
        const error = draftStructureError(draft, fileName);
        if (error) return `${draft.title.trim() || "Untitled media"}: ${error}`;
    }
    return null;
}
