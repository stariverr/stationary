import { and, eq, inArray, isNull } from "drizzle-orm";
import {
    DeleteStatus,
    File as DbFile,
    Media,
    MediaCover,
    MediaPreview,
    MediaType,
    PreviewSize,
    SyncStatus,
    Track,
    TrackPurpose,
    TrackType,
} from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { uploadToS3 } from "@/lib/utils/media";
import { renderPreview } from "@/lib/utils/preview_renderer";
import { RECIPE_VERSION } from "@/lib/utils/preview_profiles";
import { COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";

export const PREVIEW_SIZES = [PreviewSize.SMALL, PreviewSize.MEDIUM, PreviewSize.LARGE] as const;

/** Media types whose previews come from their content when they have no cover. Audio and PDF have no renderable content yet. */
const CONTENT_PREVIEW_TYPES: ReadonlySet<MediaType> = new Set([MediaType.IMAGE, MediaType.LIVE_PHOTO, MediaType.VIDEO]);

/** Content formats the renderer cannot decode; a media with nothing else gets no preview. */
const UNRENDERABLE_EXTENSIONS = new Set(["vvic", "jxl"]);

type MediaRow = typeof Media.$inferSelect;
type TrackRow = typeof Track.$inferSelect;
type FileRow = typeof DbFile.$inferSelect;
export type PreviewRow = typeof MediaPreview.$inferSelect;

/** The file a media's previews are rendered from, and whether it is decoded as an image or as a video frame. */
export interface PreviewSource {
    fileId: string;
    path: string;
    bucket: string;
    renderAs: MediaType.IMAGE | MediaType.VIDEO;
}

export interface PreviewState {
    media: MediaRow;
    source: PreviewSource | null;
    previews: PreviewRow[];
    /** Files of `previews` that are still active. */
    activePreviewFileIds: Set<string>;
}

const contentRank = (row: { track: TrackRow; file: FileRow }) =>
    [
        UNRENDERABLE_EXTENSIONS.has((row.file.extension || "").toLowerCase()) ? 1 : 0,
        row.track.type === TrackType.IMAGE ? 0 : 1,
        row.track.is_primary ? 0 : 1,
        row.track.is_default ? 0 : 1,
        row.track.priority,
    ] as const;

/**
 * The content track a preview is rendered from: renderable formats first, then an image before a video (a live
 * photo's still), primary, default, and lower priority.
 */
export function pickContentSource(rows: readonly { track: TrackRow; file: FileRow }[]): PreviewSource | null {
    const candidates = rows.filter(({ track }) => track.type === TrackType.IMAGE || track.type === TrackType.VIDEO);
    if (candidates.length === 0) return null;
    const best = [...candidates].sort((a, b) => {
        const ra = contentRank(a);
        const rb = contentRank(b);
        for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!;
        return 0;
    })[0]!;
    return {
        fileId: best.file.id,
        path: best.file.path,
        bucket: best.file.bucket,
        renderAs: best.track.type === TrackType.VIDEO ? MediaType.VIDEO : MediaType.IMAGE,
    };
}

/** What a media's previews are rendered from: its completed cover, else (for visual media) its content. */
export function previewSourceOf(
    type: MediaType,
    cover: FileRow | null,
    contents: readonly { track: TrackRow; file: FileRow }[],
): PreviewSource | null {
    if (cover && COVER_MEDIA_TYPES.has(type)) {
        return { fileId: cover.id, path: cover.path, bucket: cover.bucket, renderAs: MediaType.IMAGE };
    }
    return CONTENT_PREVIEW_TYPES.has(type) ? pickContentSource(contents) : null;
}

/** Loads what the preview pipeline needs, for each active media among `mediaIds`. */
export async function loadPreviewStates(client: DbClient, mediaIds: readonly string[]): Promise<PreviewState[]> {
    if (mediaIds.length === 0) return [];
    const mediaRows = await client
        .select()
        .from(Media)
        .where(and(inArray(Media.id, [...mediaIds]), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    if (mediaRows.length === 0) return [];
    const ids = mediaRows.map((media) => media.id);

    const [covers, contents, previews] = await Promise.all([
        client
            .select({ mediaId: MediaCover.media_id, file: DbFile })
            .from(MediaCover)
            .innerJoin(DbFile, and(eq(DbFile.id, MediaCover.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(and(inArray(MediaCover.media_id, ids), eq(MediaCover.status, SyncStatus.COMPLETED))),
        client
            .select({ track: Track, file: DbFile })
            .from(Track)
            .innerJoin(DbFile, and(eq(DbFile.id, Track.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    inArray(Track.media_id, ids),
                    eq(Track.purpose, TrackPurpose.CONTENT),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                ),
            ),
        client.select().from(MediaPreview).where(inArray(MediaPreview.media_id, ids)),
    ]);

    const previewFileIds = previews.flatMap((row) => (row.file_id ? [row.file_id] : []));
    const activePreviewFiles =
        previewFileIds.length > 0
            ? await client
                  .select({ id: DbFile.id })
                  .from(DbFile)
                  .where(and(inArray(DbFile.id, previewFileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            : [];
    const activePreviewFileIds = new Set(activePreviewFiles.map((file) => file.id));

    return mediaRows.map((media) => {
        const cover = covers.find((row) => row.mediaId === media.id)?.file ?? null;
        const source = previewSourceOf(
            media.type,
            cover,
            contents.filter((row) => row.track.media_id === media.id),
        );
        const own = previews.filter((row) => row.media_id === media.id);
        return {
            media,
            source,
            previews: own,
            activePreviewFileIds: new Set(own.flatMap((row) => (row.file_id && activePreviewFileIds.has(row.file_id) ? [row.file_id] : []))),
        };
    });
}

/**
 * The sizes to render. A size is current when its row was made from the current source with the current recipe and
 * still has its file. A failure on the current source and recipe is retried by a change or an explicit requeue, but
 * left out with `skipFailed` (library scans), so a scan does not keep retrying it.
 */
export function planPreviews(state: PreviewState, skipFailed: boolean): PreviewSize[] {
    const source = state.source;
    if (!source) return [];
    return PREVIEW_SIZES.filter((size) => {
        const row = state.previews.find((preview) => preview.size === size);
        if (!row || row.source_file_id !== source.fileId || row.recipe_version !== RECIPE_VERSION) return true;
        if (row.file_id) return !state.activePreviewFileIds.has(row.file_id);
        return !skipFailed;
    });
}

/** Whether the pipeline has anything to do: sizes to render, or previews of a media that no longer has a source. */
export function previewsNeedWork(state: PreviewState, skipFailed: boolean): boolean {
    return state.source ? planPreviews(state, skipFailed).length > 0 : state.previews.length > 0;
}

/** Soft deletes the files of the given previews that are not reused by the rows replacing them. */
async function deleteFiles(tx: DbClient, fileIds: readonly string[]): Promise<void> {
    if (fileIds.length === 0) return;
    await tx
        .update(DbFile)
        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
        .where(and(inArray(DbFile.id, [...fileIds]), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
}

/**
 * Deletes the previews of `mediaIds` and soft deletes their files; returns whether any were deleted. Used when a media
 * has no preview source any more, and by an explicit regenerate (rendering the same source again reuses the path).
 */
export async function clearPreviews(client: DbClient, mediaIds: readonly string[]): Promise<boolean> {
    if (mediaIds.length === 0) return false;
    const deleted = await client
        .delete(MediaPreview)
        .where(inArray(MediaPreview.media_id, [...mediaIds]))
        .returning({ fileId: MediaPreview.file_id });
    await deleteFiles(
        client,
        deleted.flatMap((row) => (row.fileId ? [row.fileId] : [])),
    );
    return deleted.length > 0;
}

/** Removes every preview in a library, so a scan renders them all again. */
export async function clearLibraryPreviews(client: DbClient, libraryId: string): Promise<void> {
    const deleted = await client
        .delete(MediaPreview)
        .where(inArray(MediaPreview.media_id, client.select({ id: Media.id }).from(Media).where(eq(Media.library_id, libraryId))))
        .returning({ fileId: MediaPreview.file_id });
    await deleteFiles(
        client,
        deleted.flatMap((row) => (row.fileId ? [row.fileId] : [])),
    );
}

function previewKey(media: MediaRow, size: PreviewSize, sourceFileId: string): string {
    const name = `preview/${size.toLowerCase()}/v${RECIPE_VERSION}-${sourceFileId}.avif`;
    return media.post_id
        ? `v2/p/${media.post_id.slice(-2)}/${media.post_id}/media_${media.id}/${name}`
        : `v2/m/${media.id.slice(-2)}/${media.id}/${name}`;
}

/** Writes one preview row for `size` and soft deletes the file it replaces. */
async function upsertPreview(
    tx: Transaction,
    mediaId: string,
    size: PreviewSize,
    values: Pick<PreviewRow, "source_file_id" | "file_id" | "width" | "height" | "last_error">,
): Promise<void> {
    const [existing] = await tx
        .select({ fileId: MediaPreview.file_id })
        .from(MediaPreview)
        .where(and(eq(MediaPreview.media_id, mediaId), eq(MediaPreview.size, size)))
        .for("update");
    const row = { ...values, recipe_version: RECIPE_VERSION, update_time: Temporal.Now.instant() };
    await tx
        .insert(MediaPreview)
        .values({ media_id: mediaId, size, ...row })
        .onConflictDoUpdate({ target: [MediaPreview.media_id, MediaPreview.size], set: row });
    if (existing?.fileId && existing.fileId !== values.file_id) await deleteFiles(tx, [existing.fileId]);
}

export interface RenderPreviewParams {
    state: PreviewState & { source: PreviewSource };
    size: PreviewSize;
    signal?: AbortSignal;
    /** Runs last in the transaction that stores the preview (the queue's fence goes here). */
    afterPersist?: (tx: Transaction) => Promise<void>;
}

/**
 * Renders one preview size from the state's source, uploads it, and stores it. Returns false without storing anything
 * when the media was recycled or deleted, or its preview source changed, meanwhile. Throws UndecodableSourceError when
 * the source cannot be decoded.
 */
export async function renderAndStorePreview({ state, size, signal, afterPersist }: RenderPreviewParams): Promise<boolean> {
    const { media, source } = state;
    const sourceUrl = await s3.getPresignedUrl(source.path, { bucket: source.bucket, expiresInSeconds: 900 });
    const rendered = await renderPreview(sourceUrl, source.renderAs, size, signal);
    signal?.throwIfAborted();

    const key = previewKey(media, size, source.fileId);
    await uploadToS3(key, rendered.buffer, "image/avif", env.S3_BUCKET, rendered.size, signal);
    signal?.throwIfAborted();

    return db.transaction(async (tx) => {
        const [current] = await loadPreviewStates(tx, [media.id]);
        if (current?.source?.fileId !== source.fileId) return false;

        const [file] = await tx
            .insert(DbFile)
            .values({ path: key, mime_type: "image/avif", extension: "avif", bucket: env.S3_BUCKET, size: rendered.size })
            .onConflictDoUpdate({
                target: DbFile.path,
                set: { mime_type: "image/avif", extension: "avif", size: rendered.size, delete_status: DeleteStatus.ACTIVE, delete_time: null },
            })
            .returning({ id: DbFile.id });
        await upsertPreview(tx, media.id, size, {
            source_file_id: source.fileId,
            file_id: file!.id,
            width: rendered.width,
            height: rendered.height,
            last_error: null,
        });
        await afterPersist?.(tx);
        return true;
    });
}

/** Records `error` on every size still to render, for the current source and recipe. */
export async function storePreviewFailure(tx: Transaction, state: PreviewState, error: string): Promise<void> {
    const source = state.source;
    if (!source) return;
    for (const size of planPreviews(state, false)) {
        await upsertPreview(tx, state.media.id, size, {
            source_file_id: source.fileId,
            file_id: null,
            width: null,
            height: null,
            last_error: error,
        });
    }
}

export interface PreviewImage {
    url: string;
    width: number;
    height: number;
}

export interface PreviewImages {
    small: PreviewImage | null;
    medium: PreviewImage | null;
    large: PreviewImage | null;
}

export const NO_PREVIEWS: PreviewImages = { small: null, medium: null, large: null };

/** The rendered previews of each media, for responses; every media id is in the map. */
export async function loadPreviewImages(mediaIds: readonly string[]): Promise<Map<string, PreviewImages>> {
    const result = new Map<string, PreviewImages>(mediaIds.map((id) => [id, { ...NO_PREVIEWS }]));
    if (mediaIds.length === 0) return result;
    const rows = await db
        .select({ mediaId: MediaPreview.media_id, size: MediaPreview.size, width: MediaPreview.width, height: MediaPreview.height, file: DbFile })
        .from(MediaPreview)
        .innerJoin(DbFile, and(eq(DbFile.id, MediaPreview.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
        .where(inArray(MediaPreview.media_id, [...mediaIds]));
    for (const row of rows) {
        const images = result.get(row.mediaId);
        if (!images || row.width === null || row.height === null) continue;
        const key = row.size === PreviewSize.SMALL ? "small" : row.size === PreviewSize.MEDIUM ? "medium" : "large";
        images[key] = { url: buildCdnUrl(row.file.bucket, row.file.path), width: row.width, height: row.height };
    }
    return result;
}
