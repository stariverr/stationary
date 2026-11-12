/**
 * Originals of a media and the facts probed from them (docs/media_refactor.zh-Hans.md, 3.2, 3.3, 3.6, 3.7, 4, 10).
 * Every write of an original goes through here, so the composition rules, the summary columns on `media` and the
 * single default audio track hold for uploads, imports and edits alike.
 */
import { and, asc, eq, inArray, isNotNull, ne } from "drizzle-orm";
import {
    AvFile,
    AvStream,
    AvStreamType,
    DeleteStatus,
    File as DbFile,
    Media,
    MediaCaption,
    MediaOriginal,
    MediaType,
    SyncStatus,
} from "@/db/schema";
import type { DbClient } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { insertEmbeddedCaptions } from "./captions";
import { displaySize, isImageFile, isPdfFile, type AvProbe, type OriginalProbe } from "./probe";

type OriginalRow = typeof MediaOriginal.$inferSelect;
type FileRow = typeof DbFile.$inferSelect;
type AvFileRow = typeof AvFile.$inferSelect;
type AvStreamRow = typeof AvStream.$inferSelect;

/** What an original holds, read from its probed content (3.3: there is no kind column). */
export type OriginalKind = "IMAGE" | "PDF" | "VIDEO" | "AUDIO";

export interface OriginalState {
    original: OriginalRow;
    /** The active file of a completed original. */
    file: FileRow | null;
    avFile: AvFileRow | null;
    streams: AvStreamRow[];
}

export function kindOfProbe(probe: OriginalProbe): OriginalKind {
    if (probe.kind !== "AV") return probe.kind;
    return probe.av.streams.some((stream) => stream.type === AvStreamType.VIDEO) ? "VIDEO" : "AUDIO";
}

/** The kind of a completed original, or null while it is not probed. */
export function kindOfState(state: OriginalState): OriginalKind | null {
    if (!state.file) return null;
    if (state.avFile) return state.streams.some((stream) => stream.type === AvStreamType.VIDEO) ? "VIDEO" : "AUDIO";
    if (isPdfFile(state.file)) return "PDF";
    if (isImageFile(state.file)) return "IMAGE";
    return null;
}

const ORIGINAL_COUNTS: Record<MediaType, string> = {
    [MediaType.VIDEO]: "one video original and any number of audio-only originals",
    [MediaType.AUDIO]: "one audio original",
    [MediaType.LIVE_PHOTO]: "one image original and one video original",
    [MediaType.IMAGE]: "one image original",
    [MediaType.PDF]: "one PDF original",
};

/** The count check that can run before probing, e.g. when an import arrives. */
export function originalCountError(type: MediaType, count: number): string | null {
    const ok = type === MediaType.VIDEO ? count >= 1 : type === MediaType.LIVE_PHOTO ? count === 2 : count === 1;
    return ok ? null : `${type} media takes ${ORIGINAL_COUNTS[type]}, not ${count} originals`;
}

/** The composition rules of section 4, over the probed kinds of all originals of a media. */
export function compositionError(type: MediaType, kinds: OriginalKind[]): string | null {
    const count = (kind: OriginalKind) => kinds.filter((k) => k === kind).length;
    const ok = (() => {
        switch (type) {
            case MediaType.VIDEO:
                return count("VIDEO") === 1 && count("AUDIO") === kinds.length - 1;
            case MediaType.AUDIO:
                return kinds.length === 1 && count("AUDIO") === 1;
            case MediaType.LIVE_PHOTO:
                return kinds.length === 2 && count("IMAGE") === 1 && count("VIDEO") === 1;
            case MediaType.IMAGE:
                return kinds.length === 1 && count("IMAGE") === 1;
            case MediaType.PDF:
                return kinds.length === 1 && count("PDF") === 1;
        }
    })();
    return ok ? null : `${type} media takes ${ORIGINAL_COUNTS[type]}; got ${kinds.length === 0 ? "none" : kinds.join(", ")}`;
}

/** Loads the originals of the given media with their files and probed streams, in creation order. */
export async function loadOriginalStates(client: DbClient, mediaIds: readonly string[]): Promise<Map<string, OriginalState[]>> {
    const result = new Map<string, OriginalState[]>();
    if (mediaIds.length === 0) return result;
    const rows = await client
        .select({ original: MediaOriginal, file: DbFile, avFile: AvFile })
        .from(MediaOriginal)
        .leftJoin(DbFile, and(eq(DbFile.id, MediaOriginal.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .leftJoin(AvFile, eq(AvFile.file_id, MediaOriginal.file_id))
        .where(inArray(MediaOriginal.media_id, [...mediaIds]))
        .orderBy(asc(MediaOriginal.create_time), asc(MediaOriginal.id));
    const avFileIds = rows.flatMap((row) => (row.avFile ? [row.avFile.id] : []));
    const streams =
        avFileIds.length === 0
            ? []
            : await client.select().from(AvStream).where(inArray(AvStream.av_file_id, avFileIds)).orderBy(asc(AvStream.stream_index));
    for (const row of rows) {
        const list = result.get(row.original.media_id) ?? [];
        list.push({
            original: row.original,
            file: row.file,
            avFile: row.avFile,
            streams: row.avFile ? streams.filter((stream) => stream.av_file_id === row.avFile!.id) : [],
        });
        result.set(row.original.media_id, list);
    }
    return result;
}

export interface Declarations {
    language?: string | null;
    label?: string | null;
    is_default?: boolean | null;
}

/**
 * Records the probe of an original's file: stream facts and embedded text captions for audio and video, the
 * displayed size for an image.
 */
async function storeProbe(
    client: DbClient,
    media: { id: string; type: MediaType },
    fileId: string,
    probe: OriginalProbe,
    declared: Declarations,
): Promise<AvStreamRow[]> {
    if (probe.kind === "IMAGE" && (media.type === MediaType.IMAGE || media.type === MediaType.LIVE_PHOTO)) {
        await client.update(Media).set({ display_width: probe.width, display_height: probe.height }).where(eq(Media.id, media.id));
    }
    if (probe.kind !== "AV") return [];
    const streams = await insertAvRows(client, fileId, probe.av, declared);
    if (probe.av.captions.length > 0) {
        const [row] = await client.select({ id: Media.id, post_id: Media.post_id }).from(Media).where(eq(Media.id, media.id));
        if (row) await insertEmbeddedCaptions(client, row, streams, probe.av.captions);
    }
    return streams;
}

/** Inserts the `av_file` and `av_stream` rows of a probed file; declarations apply to its audio streams. */
export async function insertAvRows(client: DbClient, fileId: string, av: AvProbe, declared: Declarations = {}): Promise<AvStreamRow[]> {
    const [avFile] = await client
        .insert(AvFile)
        .values({
            file_id: fileId,
            container: av.container,
            duration: av.duration,
            bitrate: av.bitrate,
            init_size: av.segmentIndex?.init_size ?? null,
            index_offset: av.segmentIndex?.index_offset ?? null,
            index_size: av.segmentIndex?.index_size ?? null,
            timescale: av.segmentIndex?.timescale ?? null,
            earliest_presentation_time: av.segmentIndex?.earliest_presentation_time ?? null,
        })
        .returning({ id: AvFile.id });
    return client
        .insert(AvStream)
        .values(
            av.streams.map((stream) => {
                const audio = stream.type === AvStreamType.AUDIO;
                return {
                    ...stream,
                    av_file_id: avFile!.id,
                    language: (audio && declared.language) || stream.language,
                    label: (audio && declared.label) || stream.label,
                    is_default: audio && declared.is_default != null ? declared.is_default : stream.is_default,
                };
            }),
        )
        .returning();
}

/**
 * Recomputes the probed summary of a media from its completed audio and video originals: the longest duration, and
 * for VIDEO the displayed size of its video stream. Image sizes are written by `storeProbe` when the image is probed.
 */
export async function refreshAvSummary(client: DbClient, media: { id: string; type: MediaType }): Promise<void> {
    if (media.type === MediaType.IMAGE || media.type === MediaType.PDF) return;
    const states = (await loadOriginalStates(client, [media.id])).get(media.id) ?? [];
    const durations = states.flatMap((state) => (state.file && state.avFile?.duration != null ? [state.avFile.duration] : []));
    const values: Partial<typeof Media.$inferInsert> = { duration: durations.length > 0 ? Math.max(...durations) : null };
    if (media.type === MediaType.VIDEO) {
        const video = states.flatMap((state) => (state.file ? state.streams : [])).find((stream) => stream.type === AvStreamType.VIDEO);
        const size = video ? displaySize({ width: video.width!, height: video.height!, rotation: video.rotation }) : null;
        values.display_width = size?.width ?? null;
        values.display_height = size?.height ?? null;
    }
    await client.update(Media).set(values).where(eq(Media.id, media.id));
}

/**
 * Keeps exactly one default audio track across all originals of a media (3.7): `preferred` wins when given, else an
 * existing default stays, else the first audio stream becomes the default.
 */
export async function settleDefaultAudio(client: DbClient, mediaId: string, preferred?: string): Promise<void> {
    const states = (await loadOriginalStates(client, [mediaId])).get(mediaId) ?? [];
    const audio = states.flatMap((state) => (state.file ? state.streams : [])).filter((stream) => stream.type === AvStreamType.AUDIO);
    if (audio.length === 0) return;
    const keep = audio.find((stream) => stream.id === preferred) ?? audio.find((stream) => stream.is_default) ?? audio[0]!;
    const ids = audio.map((stream) => stream.id);
    await client.update(AvStream).set({ is_default: false }).where(and(inArray(AvStream.id, ids), ne(AvStream.id, keep.id), eq(AvStream.is_default, true)));
    if (!keep.is_default) await client.update(AvStream).set({ is_default: true }).where(eq(AvStream.id, keep.id));
}

/**
 * Completes an original with its stored and probed file. The caller has checked the composition; this records the
 * probe, refreshes the media summary and reports the content change.
 */
export async function completeOriginal(
    client: DbClient,
    media: { id: string; type: MediaType },
    originalId: string,
    fileId: string,
    probe: OriginalProbe,
): Promise<void> {
    const [original] = await client
        .update(MediaOriginal)
        .set({ file_id: fileId, status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() })
        .where(eq(MediaOriginal.id, originalId))
        .returning();
    if (!original) return;
    const streams = await storeProbe(client, media, fileId, probe, {
        language: original.declared_language,
        label: original.declared_label,
        is_default: original.declared_default,
    });
    // A declared default takes over from whatever audio track was the default before.
    const declaredDefault = original.declared_default ? streams.find((stream) => stream.type === AvStreamType.AUDIO)?.id : undefined;
    await settleAfterOriginalChange(client, media, declaredDefault);
}

/** Inserts an original the user uploaded: it is probed already, so it is complete from the start. */
export async function insertUploadedOriginal(
    client: DbClient,
    media: { id: string; type: MediaType },
    fileId: string,
    probe: OriginalProbe,
): Promise<string> {
    const [original] = await client
        .insert(MediaOriginal)
        .values({ media_id: media.id, file_id: fileId, status: SyncStatus.COMPLETED })
        .returning({ id: MediaOriginal.id });
    await storeProbe(client, media, fileId, probe, {});
    await settleAfterOriginalChange(client, media);
    return original!.id;
}

async function settleAfterOriginalChange(client: DbClient, media: { id: string; type: MediaType }, preferredAudio?: string) {
    await refreshAvSummary(client, media);
    await settleDefaultAudio(client, media.id, preferredAudio);
    await markChanged(client, Aspect.MEDIA_CONTENT, [media.id]);
}

async function softDeleteFiles(client: DbClient, fileIds: (string | null)[]) {
    const ids = fileIds.filter((id): id is string => Boolean(id));
    if (ids.length === 0) return;
    await client
        .update(DbFile)
        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
        .where(and(inArray(DbFile.id, ids), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
}

/**
 * Deletes originals with everything that hangs off them (10): their stream rows and the captions extracted from
 * them; their files are marked deleted. Previews follow through the content change. Returns the affected media.
 */
export async function deleteOriginals(client: DbClient, where: { ids?: readonly string[]; mediaIds?: readonly string[] }): Promise<string[]> {
    const condition = where.ids ? inArray(MediaOriginal.id, [...where.ids]) : inArray(MediaOriginal.media_id, [...(where.mediaIds ?? [])]);
    if ((where.ids ?? where.mediaIds ?? []).length === 0) return [];
    const originals = await client.delete(MediaOriginal).where(condition).returning();
    if (originals.length === 0) return [];
    const fileIds = originals.map((original) => original.file_id).filter((id): id is string => Boolean(id));
    if (fileIds.length > 0) {
        const avFiles = await client.delete(AvFile).where(inArray(AvFile.file_id, fileIds)).returning({ id: AvFile.id });
        if (avFiles.length > 0) {
            const streams = await client
                .delete(AvStream)
                .where(
                    inArray(
                        AvStream.av_file_id,
                        avFiles.map((file) => file.id),
                    ),
                )
                .returning({ id: AvStream.id });
            if (streams.length > 0) {
                const captions = await client
                    .delete(MediaCaption)
                    .where(
                        and(
                            isNotNull(MediaCaption.source_stream_id),
                            inArray(
                                MediaCaption.source_stream_id,
                                streams.map((stream) => stream.id),
                            ),
                        ),
                    )
                    .returning({ vtt: MediaCaption.vtt_file_id });
                await softDeleteFiles(
                    client,
                    captions.map((caption) => caption.vtt),
                );
            }
        }
        await softDeleteFiles(client, fileIds);
    }
    return [...new Set(originals.map((original) => original.media_id))];
}

/** Deletes one original of a media the user edits, then settles the summary and default audio around the rest. */
export async function removeOriginal(client: DbClient, media: { id: string; type: MediaType }, originalId: string): Promise<boolean> {
    const state = ((await loadOriginalStates(client, [media.id])).get(media.id) ?? []).find((s) => s.original.id === originalId);
    if (!state) return false;
    await deleteOriginals(client, { ids: [originalId] });
    // The displayed size of an image or Live Photo comes from its image original.
    if (kindOfState(state) === "IMAGE") {
        await client.update(Media).set({ display_width: null, display_height: null }).where(eq(Media.id, media.id));
    }
    await settleAfterOriginalChange(client, media);
    return true;
}
