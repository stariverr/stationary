/**
 * User edits of a media's type, originals, captions, cover and audio tracks (docs/media_refactor.zh-Hans.md, 3.7, 3.8,
 * 4, 10; docs/failure_handling.zh-Hans.md, 8, 9.1). New files come in as draft files of the library; they are probed
 * before anything is written, and every edit leaves a media that satisfies the composition rules, judged by the
 * probed kind of completed originals and the declared kind of the others.
 * An imported source the user deletes or replaces is excluded, so later imports do not bring it back. Each edit runs
 * in one transaction that locks the post first and refreshes the media's sync status last.
 */
import { and, eq } from "drizzle-orm";
import {
    AvFile,
    AvStream,
    AvStreamType,
    DeleteStatus,
    DraftFile,
    DraftFileStatus,
    File as DbFile,
    Media,
    MediaCaption,
    MediaCover,
    MediaOriginal,
    MediaType,
    SyncStatus,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { consumeDraftFile } from "@/features/import/draft-file";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { getFileCategories } from "@/lib/utils/file";
import { CAPTION_MEDIA_TYPES, compositionError, COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";
import {
    convertToVtt,
    deleteCaptions,
    deleteMediaCaptions,
    insertUploadedCaption,
    makeDefaultCaption,
    storeVtt,
    type CaptionDeclaration,
} from "./captions";
import { lockPosts, refreshMediaSyncStatus } from "./composition";
import { CoverNotAllowedError, CoverService, type UploadedCoverFile } from "./cover";
import {
    deleteOriginals,
    insertUploadedOriginal,
    kindOfOriginal,
    kindOfProbe,
    loadOriginalStates,
    refreshAvSummary,
    removeOriginal,
    settleDefaultAudio,
    type OriginalKind,
    type OriginalState,
} from "./originals";
import { excludeSources, withValues, type SourceKind } from "./ownership";
import { probeOriginal, ProbeRejectedError } from "./probe";
import { Priority } from "@/infra/queue/policy";
import { isRetryable, NO_SOURCE_ERROR } from "./source-rows";

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

/**
 * Runs an edit of one media: locks its post, then the media, hands the edit the media as it is now, and refreshes the
 * sync status of the media and its post from the sources the edit left (docs/failure_handling.zh-Hans.md, 4.4).
 */
function editMedia<T>(mediaId: string, edit: (tx: Transaction, media: MediaRow) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [mediaId] });
        const [media] = await tx
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .for("update");
        if (!media) throw new MediaEditError(404, "Media not found");
        const result = await edit(tx, media);
        await refreshMediaSyncStatus(tx, [mediaId]);
        return result;
    });
}

async function originalStates(tx: Transaction, mediaId: string): Promise<OriginalState[]> {
    return (await loadOriginalStates(tx, [mediaId])).get(mediaId) ?? [];
}

/** Why a media of `type` cannot be made of the given originals plus `added`, or null when it can. */
function compositionOf(type: MediaType, states: readonly OriginalState[], added: OriginalKind[] = []): string | null {
    const kinds = [...states.map(kindOfOriginal), ...added];
    if (kinds.includes(null)) return "An original is of no known kind";
    return compositionError(type, kinds as OriginalKind[]);
}

/**
 * Adds an original from a draft file, or replaces `replaces` with it; the media must stay well composed. A replaced
 * imported original is excluded, and the upload takes over its declarations (docs/failure_handling.zh-Hans.md, 8.1).
 */
export async function addOriginal(media: MediaRow, draftFileId: string, replaces?: string): Promise<string> {
    const { draft, file } = await loadDraftFile(media.library_id, draftFileId);
    let probe;
    try {
        probe = await probeOriginal(file);
    } catch (error) {
        if (error instanceof ProbeRejectedError) throw new MediaEditError(400, `${draft.original_name}: ${error.message}`);
        throw error;
    }

    return editMedia(media.id, async (tx, current) => {
        const states = await originalStates(tx, current.id);
        const replaced = replaces ? states.find((state) => state.original.id === replaces) : undefined;
        if (replaces && !replaced) throw new MediaEditError(404, "Original not found");
        const composition = compositionOf(
            current.type,
            states.filter((state) => state !== replaced),
            [kindOfProbe(probe)],
        );
        if (composition) throw new MediaEditError(400, composition);

        if (replaced) {
            await excludeSources(tx, current.id, [{ kind: "original", sourceKey: replaced.original.source_key }]);
            await deleteOriginals(tx, { ids: [replaced.original.id] });
        }
        const fileId = await consumeDraftFile(tx, draftFileId, current.library_id);
        return insertUploadedOriginal(tx, current, fileId, probe, Priority.CHANGE, {
            language: replaced?.original.declared_language,
            label: replaced?.original.declared_label,
            is_default: replaced?.original.declared_default,
        });
    });
}

/** Deletes an original; refused when the media would no longer be well composed (e.g. its only video). */
export async function deleteOriginal(media: MediaRow, originalId: string): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const states = await originalStates(tx, current.id);
        const deleted = states.find((state) => state.original.id === originalId);
        if (!deleted) throw new MediaEditError(404, "Original not found");
        const composition = compositionOf(
            current.type,
            states.filter((state) => state !== deleted),
        );
        if (composition) throw new MediaEditError(400, `Deleting it would leave the media incomplete: ${composition}`);
        await excludeSources(tx, current.id, [{ kind: "original", sourceKey: deleted.original.source_key }]);
        await removeOriginal(tx, current, originalId, Priority.CHANGE);
    });
}

/**
 * Changes the type of a media and deletes the originals the new type does not take, checked as a whole
 * (docs/failure_handling.zh-Hans.md, 9.1): a LIVE_PHOTO whose video is broken becomes an IMAGE without it. Captions
 * and the cover go when the new type has none; the type is the user's from then on (8.2).
 */
export async function changeType(media: MediaRow, type: MediaType, deleteOriginalIds: readonly string[]): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const states = await originalStates(tx, current.id);
        const ids = new Set(deleteOriginalIds);
        const deleted = states.filter((state) => ids.has(state.original.id));
        if (deleted.length !== ids.size) throw new MediaEditError(404, "Original not found");
        const composition = compositionOf(
            type,
            states.filter((state) => !ids.has(state.original.id)),
        );
        if (composition) throw new MediaEditError(400, composition);

        await excludeSources(
            tx,
            current.id,
            deleted.map((state) => ({ kind: "original", sourceKey: state.original.source_key })),
        );
        for (const state of deleted) await removeOriginal(tx, current, state.original.id, Priority.CHANGE);
        if (type === current.type) return;

        if (!CAPTION_MEDIA_TYPES.has(type)) await deleteMediaCaptions(tx, [current.id]);
        if (!COVER_MEDIA_TYPES.has(type)) await CoverService.remove(tx, current.id, Priority.CHANGE);
        await tx
            .update(Media)
            .set({
                type,
                user_edited_fields: withValues(Media.user_edited_fields, ["type"]),
                // The probed summary follows the type: an image or PDF has no duration, audio or a PDF no size.
                ...(type === MediaType.IMAGE || type === MediaType.PDF ? { duration: null } : {}),
                ...(type === MediaType.AUDIO || type === MediaType.PDF ? { display_width: null, display_height: null } : {}),
                update_time: Temporal.Now.instant(),
            })
            .where(eq(Media.id, current.id));
        await refreshAvSummary(tx, { id: current.id, type });
        await settleDefaultAudio(tx, current.id);
        // Previews, playback and descriptions are made by type.
        await markChanged(tx, Aspect.MEDIA_CONTENT, [current.id], Priority.CHANGE);
    });
}

async function loadCaptionFile(media: MediaRow, draftFileId: string) {
    const { draft, file } = await loadDraftFile(media.library_id, draftFileId);
    if (!getFileCategories(draft.original_name, file.mime_type).includes("SUBTITLE")) {
        throw new MediaEditError(400, `${draft.original_name} is not a caption file`);
    }
    try {
        return await convertToVtt(file);
    } catch (error) {
        if (error instanceof ProbeRejectedError) throw new MediaEditError(400, `${draft.original_name}: ${error.message}`);
        throw error;
    }
}

/**
 * Adds a caption from a draft subtitle file, converted to WebVTT, or replaces `replaces` with it. A replacement keeps
 * the language, label and default of the caption it replaces unless given, and an imported one is excluded
 * (docs/failure_handling.zh-Hans.md, 8.1).
 */
export async function addCaption(media: MediaRow, draftFileId: string, declared: CaptionDeclaration, replaces?: string): Promise<string> {
    if (!CAPTION_MEDIA_TYPES.has(media.type)) throw new MediaEditError(400, `${media.type} media cannot have captions`);
    const vtt = await loadCaptionFile(media, draftFileId);
    return editMedia(media.id, async (tx, current) => {
        if (!CAPTION_MEDIA_TYPES.has(current.type)) throw new MediaEditError(400, `${current.type} media cannot have captions`);
        let inherited: CaptionDeclaration = {};
        if (replaces) {
            const [replaced] = await tx
                .select()
                .from(MediaCaption)
                .where(and(eq(MediaCaption.id, replaces), eq(MediaCaption.media_id, current.id)))
                .for("update");
            if (!replaced) throw new MediaEditError(404, "Caption not found");
            inherited = { language: replaced.language, label: replaced.label, is_default: replaced.is_default };
            await excludeSources(tx, current.id, [{ kind: "caption", sourceKey: replaced.source_key }]);
            await deleteCaptions(tx, current.id, [replaced.id]);
        }
        const sourceFileId = await consumeDraftFile(tx, draftFileId, current.library_id);
        const vttFileId = await storeVtt(tx, current, draftFileId, vtt);
        return insertUploadedCaption(tx, current.id, { sourceFileId, vttFileId }, { ...inherited, ...definedOnly(declared) });
    });
}

const definedOnly = (declared: CaptionDeclaration): CaptionDeclaration =>
    Object.fromEntries(Object.entries(declared).filter(([, value]) => value !== undefined));

export async function updateCaption(media: MediaRow, captionId: string, patch: CaptionDeclaration): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const [caption] = await tx
            .update(MediaCaption)
            .set({
                ...(patch.language !== undefined ? { language: patch.language } : {}),
                ...(patch.label !== undefined ? { label: patch.label } : {}),
                ...(patch.is_default === false ? { is_default: false } : {}),
                update_time: Temporal.Now.instant(),
            })
            .where(and(eq(MediaCaption.id, captionId), eq(MediaCaption.media_id, current.id)))
            .returning({ id: MediaCaption.id });
        if (!caption) throw new MediaEditError(404, "Caption not found");
        if (patch.is_default) await makeDefaultCaption(tx, current.id, captionId);
    });
}

/** Deletes a caption; an imported one is excluded. */
export async function deleteCaption(media: MediaRow, captionId: string): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const [caption] = await tx
            .select({ id: MediaCaption.id, source_key: MediaCaption.source_key })
            .from(MediaCaption)
            .where(and(eq(MediaCaption.id, captionId), eq(MediaCaption.media_id, current.id)))
            .for("update");
        if (!caption) throw new MediaEditError(404, "Caption not found");
        await excludeSources(tx, current.id, [{ kind: "caption", sourceKey: caption.source_key }]);
        await deleteCaptions(tx, current.id, [caption.id]);
    });
}

async function coverKey(tx: Transaction, mediaId: string) {
    const [cover] = await tx
        .select({ source_key: MediaCover.source_key })
        .from(MediaCover)
        .where(eq(MediaCover.media_id, mediaId))
        .for("update");
    return cover;
}

/** Sets the cover to an image the user uploaded; an imported cover it replaces is excluded. */
export async function setCover(media: MediaRow, upload: UploadedCoverFile): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const replaced = await coverKey(tx, current.id);
        try {
            await CoverService.setUploaded(tx, current, upload, Priority.CHANGE);
        } catch (error) {
            if (error instanceof CoverNotAllowedError) throw new MediaEditError(400, error.message);
            throw error;
        }
        await excludeSources(tx, current.id, [{ kind: "cover", sourceKey: replaced?.source_key ?? null }]);
    });
}

/** Removes the cover; an imported one is excluded. */
export async function removeCover(media: MediaRow): Promise<void> {
    await editMedia(media.id, async (tx, current) => {
        const removed = await coverKey(tx, current.id);
        if (!removed) throw new MediaEditError(404, "Media has no cover");
        await excludeSources(tx, current.id, [{ kind: "cover", sourceKey: removed.source_key }]);
        await CoverService.remove(tx, current.id, Priority.CHANGE);
    });
}

const SOURCE_TABLES = { original: MediaOriginal, caption: MediaCaption, cover: MediaCover } as const;

/**
 * Retries one imported source that failed for a retryable reason (NETWORK, INTERNAL): it waits for the download again
 * (docs/failure_handling.zh-Hans.md, 4.3, 9.1). The others need a new URL or a fix in the editor. A cover is named by
 * its media alone.
 */
export async function retrySource(media: MediaRow, kind: SourceKind, sourceId?: string): Promise<void> {
    const table = SOURCE_TABLES[kind];
    await editMedia(media.id, async (tx, current) => {
        const [row] = await tx
            .select()
            .from(table)
            .where(and(eq(table.media_id, current.id), sourceId ? eq(table.id, sourceId) : undefined))
            .for("update");
        if (!row) throw new MediaEditError(404, "Source not found");
        if (!isRetryable(row)) throw new MediaEditError(400, "Only a source that failed for a network or server error can be retried");
        await tx
            .update(table)
            .set({ status: SyncStatus.PENDING, ...NO_SOURCE_ERROR, update_time: Temporal.Now.instant() })
            .where(eq(table.id, row.id));
        await markChanged(tx, Aspect.MEDIA_SOURCE, [current.id], Priority.CHANGE);
    });
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
