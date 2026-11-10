/**
 * User edits of a media's originals, captions and audio tracks (docs/media_refactor.zh-Hans.md, 3.7, 3.8, 4, 10).
 * New files come in as draft files of the library; originals are probed before anything is written, and every edit
 * leaves a media that satisfies the composition rules.
 */
import { and, eq } from "drizzle-orm";
import { AvFile, AvStream, AvStreamType, DraftFile, DraftFileStatus, File as DbFile, Media, MediaCaption, MediaOriginal } from "@/db/schema";
import { db } from "@/global/db";
import { consumeDraftFile } from "@/features/import/draft-file";
import { getFileCategories } from "@/lib/utils/file";
import { CAPTION_MEDIA_TYPES } from "@/lib/validation/media-composition";
import { convertToVtt, deleteCaptions, insertUploadedCaption, makeDefaultCaption, storeVtt, type CaptionDeclaration } from "./captions";
import { compositionError, deleteOriginals, insertUploadedOriginal, kindOfProbe, kindOfState, loadOriginalStates, removeOriginal, settleDefaultAudio } from "./originals";
import { probeOriginal, ProbeRejectedError } from "./probe";

type MediaRow = typeof Media.$inferSelect;

export class MediaEditError extends Error {
    constructor(
        public readonly status: 400 | 404,
        message: string,
    ) {
        super(message);
        this.name = "MediaEditError";
    }
}

async function loadDraftFile(libraryId: string, draftFileId: string) {
    const [row] = await db
        .select({ draft: DraftFile, file: DbFile })
        .from(DraftFile)
        .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
        .where(and(eq(DraftFile.id, draftFileId), eq(DraftFile.library_id, libraryId), eq(DraftFile.status, DraftFileStatus.DRAFT)))
        .limit(1);
    if (!row) throw new MediaEditError(400, `Draft file ${draftFileId} is invalid or already consumed`);
    return row;
}

/** Adds an original from a draft file, or replaces `replaces` with it; the media must stay well composed. */
export async function addOriginal(media: MediaRow, draftFileId: string, replaces?: string): Promise<string> {
    const { draft, file } = await loadDraftFile(media.library_id, draftFileId);
    let probe;
    try {
        probe = await probeOriginal(file);
    } catch (error) {
        if (error instanceof ProbeRejectedError) throw new MediaEditError(400, `${draft.original_name}: ${error.message}`);
        throw error;
    }

    const states = (await loadOriginalStates(db, [media.id])).get(media.id) ?? [];
    if (replaces && !states.some((state) => state.original.id === replaces)) throw new MediaEditError(404, "Original not found");
    const kinds = [...states.filter((state) => state.original.id !== replaces).map(kindOfState), kindOfProbe(probe)];
    const composition = kinds.includes(null) ? "Wait until the other originals are downloaded" : compositionError(media.type, kinds as NonNullable<(typeof kinds)[number]>[]);
    if (composition) throw new MediaEditError(400, composition);

    return db.transaction(async (tx) => {
        if (replaces) await deleteOriginals(tx, { ids: [replaces] });
        const fileId = await consumeDraftFile(tx, draftFileId, media.library_id);
        return insertUploadedOriginal(tx, media, fileId, probe);
    });
}

/** Deletes an original; refused when the media would no longer be well composed (e.g. its only video). */
export async function deleteOriginal(media: MediaRow, originalId: string): Promise<void> {
    const states = (await loadOriginalStates(db, [media.id])).get(media.id) ?? [];
    if (!states.some((state) => state.original.id === originalId)) throw new MediaEditError(404, "Original not found");
    const kinds = states.filter((state) => state.original.id !== originalId).map(kindOfState);
    const composition = kinds.includes(null) ? null : compositionError(media.type, kinds as NonNullable<(typeof kinds)[number]>[]);
    if (composition) throw new MediaEditError(400, `Deleting it would leave the media incomplete: ${composition}`);
    await db.transaction((tx) => removeOriginal(tx, media, originalId));
}

/** Adds a caption from a draft subtitle file, converted to WebVTT. */
export async function addCaption(media: MediaRow, draftFileId: string, declared: CaptionDeclaration): Promise<string> {
    if (!CAPTION_MEDIA_TYPES.has(media.type)) throw new MediaEditError(400, `${media.type} media cannot have captions`);
    const { draft, file } = await loadDraftFile(media.library_id, draftFileId);
    if (!getFileCategories(draft.original_name, file.mime_type).includes("SUBTITLE")) {
        throw new MediaEditError(400, `${draft.original_name} is not a caption file`);
    }
    let vtt: Uint8Array;
    try {
        vtt = await convertToVtt(file);
    } catch (error) {
        if (error instanceof ProbeRejectedError) throw new MediaEditError(400, `${draft.original_name}: ${error.message}`);
        throw error;
    }
    return db.transaction(async (tx) => {
        const sourceFileId = await consumeDraftFile(tx, draftFileId, media.library_id);
        const vttFileId = await storeVtt(tx, media, draftFileId, vtt);
        return insertUploadedCaption(tx, media.id, { sourceFileId, vttFileId }, declared);
    });
}

export async function updateCaption(media: MediaRow, captionId: string, patch: CaptionDeclaration): Promise<void> {
    await db.transaction(async (tx) => {
        const [caption] = await tx
            .update(MediaCaption)
            .set({
                ...(patch.language !== undefined ? { language: patch.language } : {}),
                ...(patch.label !== undefined ? { label: patch.label } : {}),
                ...(patch.is_default === false ? { is_default: false } : {}),
                update_time: Temporal.Now.instant(),
            })
            .where(and(eq(MediaCaption.id, captionId), eq(MediaCaption.media_id, media.id)))
            .returning({ id: MediaCaption.id });
        if (!caption) throw new MediaEditError(404, "Caption not found");
        if (patch.is_default) await makeDefaultCaption(tx, media.id, captionId);
    });
}

export async function deleteCaption(media: MediaRow, captionId: string): Promise<void> {
    const deleted = await db.transaction((tx) => deleteCaptions(tx, media.id, [captionId]));
    if (deleted.length === 0) throw new MediaEditError(404, "Caption not found");
}

/** Renames or relabels an audio track, or makes it the media's default. */
export async function updateAudioTrack(media: MediaRow, streamId: string, patch: CaptionDeclaration): Promise<void> {
    await db.transaction(async (tx) => {
        const [stream] = await tx
            .select({ id: AvStream.id })
            .from(AvStream)
            .innerJoin(AvFile, eq(AvFile.id, AvStream.av_file_id))
            .innerJoin(MediaOriginal, eq(MediaOriginal.file_id, AvFile.file_id))
            .where(and(eq(AvStream.id, streamId), eq(AvStream.type, AvStreamType.AUDIO), eq(MediaOriginal.media_id, media.id)))
            .limit(1);
        if (!stream) throw new MediaEditError(404, "Audio track not found");
        const values = {
            ...(patch.language !== undefined ? { language: patch.language } : {}),
            ...(patch.label !== undefined ? { label: patch.label } : {}),
        };
        if (Object.keys(values).length > 0) await tx.update(AvStream).set(values).where(eq(AvStream.id, streamId));
        // There is always exactly one default audio track, so it can be moved but not cleared.
        if (patch.is_default) await settleDefaultAudio(tx, media.id, streamId);
    });
}
