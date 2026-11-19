import { setTimeout as delay } from "node:timers/promises";
import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { DeleteStatus, File, Media, MediaCaption, MediaCover, MediaOriginal, SourceErrorKind, SyncStatus } from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { env } from "@/global/env";
import { convertToVtt, makeDefaultCaption, storeVtt } from "@/features/media/captions";
import { lockPosts, refreshMediaSyncStatus } from "@/features/media/composition";
import { completeOriginal } from "@/features/media/originals";
import { probeOriginal } from "@/features/media/probe";
import { NO_SOURCE_ERROR, resetRetryableSources } from "@/features/media/source-rows";
import { mediaStoragePath } from "@/features/media/storage";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { ReconcileContext, ReconcileResult, SubjectPipelineHandler } from "@/infra/queue/types";
import { DownloadStatusError, downloadStream, getBodyLength, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";
import { classifySourceError, SourceTransferError, type SourceError } from "./source-errors";

type MediaRow = typeof Media.$inferSelect;
type OriginalRow = typeof MediaOriginal.$inferSelect;
type CaptionRow = typeof MediaCaption.$inferSelect;
type CoverRow = typeof MediaCover.$inferSelect;

const activeMedia = (mediaId: string) =>
    and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

type SourceTable = typeof MediaOriginal | typeof MediaCaption | typeof MediaCover;
type SourceRow = { id: string; source_url: string | null; source_key: string | null };

/**
 * An imported source still waiting for its download. A FAILED one failed on its current URL and waits for a new URL
 * or a retry, which make it PENDING again (docs/failure_handling.zh-Hans.md, 4.3). Originals, captions and covers
 * share the shape.
 */
function pendingSource(table: SourceTable): SQL {
    return and(isNotNull(table.source_url), inArray(table.status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS]))!;
}

/** How long to wait before trying a source that answered 403 once more: CDNs also refuse for a moment. */
const FORBIDDEN_RETRY_DELAY_MS = 3_000;

/** Objects are named after the source key, so a new source never overwrites a file a CDN may still serve. */
const keyName = (sourceKey: string) => new Bun.CryptoHasher("sha256").update(sourceKey).digest("hex").slice(0, 16);

/** Inserts the file at `path`, or revives the row a previous download of the same object left there. */
async function upsertFile(client: DbClient, values: { path: string; mime_type: string; extension: string; size: number | null }) {
    const [file] = await client
        .insert(File)
        .values({ ...values, bucket: env.S3_BUCKET })
        .onConflictDoUpdate({
            target: File.path,
            set: { mime_type: values.mime_type, extension: values.extension, size: values.size, delete_status: DeleteStatus.ACTIVE, delete_time: null },
        })
        .returning();
    return file!;
}

async function softDeleteFile(client: DbClient, fileId: string) {
    await client
        .update(File)
        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
        .where(and(eq(File.id, fileId), eq(File.delete_status, DeleteStatus.ACTIVE)));
}

/** Opens a source; a 403 is tried once more after a short pause, as a CDN may refuse for a moment. */
async function openSource(url: string, signal: AbortSignal): Promise<Response | null> {
    try {
        return await downloadStream(url, { signal });
    } catch (error) {
        if (!(error instanceof DownloadStatusError && error.status === 403)) throw error;
        await delay(FORBIDDEN_RETRY_DELAY_MS, undefined, { signal });
        return downloadStream(url, { signal });
    }
}

/**
 * Passes a source's body through, remembering an error reading it, so a source that breaks off mid-transfer is told
 * apart from storage that fails to take it.
 */
function watchSource(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    const watched: { stream?: ReadableStream<Uint8Array>; error?: unknown } = {};
    watched.stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const chunk = await reader.read();
                if (chunk.done) controller.close();
                else controller.enqueue(chunk.value);
            } catch (error) {
                watched.error = error;
                controller.error(error);
            }
        },
        cancel: (reason) => reader.cancel(reason),
    });
    return watched as { stream: ReadableStream<Uint8Array>; error?: unknown };
}

/**
 * Downloads a source into storage under `media`, as `<prefix>_<key>.<ext>`, and records its file. A refusal keeps its
 * status and a source that cannot be reached or breaks off is a SourceTransferError; storage errors stay as they are.
 */
async function fetchSource(ctx: ReconcileContext, media: MediaRow, source: SourceRow, prefix: string) {
    const sourceUrl = source.source_url!;
    let response: Response | null;
    try {
        response = await openSource(sourceUrl, ctx.signal);
    } catch (error) {
        if (ctx.signal.aborted || error instanceof DownloadStatusError) throw error;
        throw new SourceTransferError(error);
    }
    if (!response?.body) throw new SourceTransferError(new Error(`Download of ${sourceUrl} returned no body`));

    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    const size = getBodyLength(response) ?? null;
    const ext = getExtensionFromContentType(contentType, sourceUrl);
    const path = mediaStoragePath(media, `${prefix}_${keyName(source.source_key!)}.${ext}`);
    const body = watchSource(response.body);
    try {
        await uploadToS3(path, body.stream, contentType, env.S3_BUCKET, size ?? undefined, ctx.signal);
    } catch (error) {
        if (!ctx.signal.aborted && body.error !== undefined) throw new SourceTransferError(body.error);
        throw error;
    }
    ctx.signal.throwIfAborted();
    return upsertFile(db, { path, mime_type: contentType, extension: ext, size });
}

/** Downloads and probes one original, then completes it unless the import replaced or removed it meanwhile. */
async function downloadOriginal(ctx: ReconcileContext, media: MediaRow, original: OriginalRow): Promise<void> {
    const file = await fetchSource(ctx, media, original, "original");
    let probe;
    try {
        probe = await probeOriginal(file);
    } catch (error) {
        await softDeleteFile(db, file.id);
        throw error;
    }

    await db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [media.id] });
        const [current] = await tx
            .select({ id: MediaOriginal.id })
            .from(MediaOriginal)
            .where(and(eq(MediaOriginal.id, original.id), eq(MediaOriginal.source_key, original.source_key!)))
            .for("update");
        if (!current) return softDeleteFile(tx, file.id);
        await completeOriginal(tx, media, original.id, file.id, probe, ctx.priority);
        await refreshMediaSyncStatus(tx, [media.id]);
        await ctx.fence(tx);
    });
}

/** Downloads one caption and converts it to WebVTT, keeping the downloaded file as its source. */
async function downloadCaption(ctx: ReconcileContext, media: MediaRow, caption: CaptionRow): Promise<void> {
    const file = await fetchSource(ctx, media, caption, "caption_source");
    let vtt: Uint8Array;
    try {
        vtt = await convertToVtt(file);
    } catch (error) {
        await softDeleteFile(db, file.id);
        throw error;
    }

    await db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [media.id] });
        const [current] = await tx
            .select({ id: MediaCaption.id, is_default: MediaCaption.is_default })
            .from(MediaCaption)
            .where(and(eq(MediaCaption.id, caption.id), eq(MediaCaption.source_key, caption.source_key!)))
            .for("update");
        if (!current) return softDeleteFile(tx, file.id);
        const vttFileId = await storeVtt(tx, media, keyName(caption.source_key!), vtt);
        await tx
            .update(MediaCaption)
            .set({ source_file_id: file.id, vtt_file_id: vttFileId, status: SyncStatus.COMPLETED, ...NO_SOURCE_ERROR, update_time: Temporal.Now.instant() })
            .where(eq(MediaCaption.id, caption.id));
        if (current.is_default) await makeDefaultCaption(tx, media.id, caption.id);
        await refreshMediaSyncStatus(tx, [media.id]);
        await ctx.fence(tx);
        await markChanged(tx, Aspect.MEDIA_CONTENT, [media.id], ctx.priority);
    });
}

/**
 * Downloads the imported cover into storage and completes it, unless the import replaced its source meanwhile. The
 * object is named after its source URL, so a new cover never overwrites one a CDN may still serve.
 */
async function downloadCover(ctx: ReconcileContext, media: MediaRow, cover: CoverRow): Promise<void> {
    const file = await fetchSource(ctx, media, cover, "cover");
    await db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [media.id] });
        const completed = await tx
            .update(MediaCover)
            .set({ file_id: file.id, status: SyncStatus.COMPLETED, ...NO_SOURCE_ERROR, update_time: Temporal.Now.instant() })
            .where(and(eq(MediaCover.id, cover.id), eq(MediaCover.source_key, cover.source_key!)))
            .returning({ id: MediaCover.id });
        if (completed.length === 0) return softDeleteFile(tx, file.id);
        await refreshMediaSyncStatus(tx, [media.id]);
        await ctx.fence(tx);
        await markChanged(tx, Aspect.MEDIA_COVER, [media.id], ctx.priority);
    });
}

/** Marks a source as downloading, unless the import gave it another URL or it completed meanwhile. */
async function startSource(ctx: ReconcileContext, table: SourceTable, row: SourceRow) {
    await db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [ctx.subjectId] });
        await tx
            .update(table)
            .set({ status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
            .where(and(eq(table.id, row.id), eq(table.source_url, row.source_url!), ne(table.status, SyncStatus.COMPLETED)));
        await refreshMediaSyncStatus(tx, [ctx.subjectId]);
        await ctx.fence(tx);
    });
}

/**
 * Records the error of a download on its row, bound to the URL it happened on: PENDING while it is retried, FAILED
 * when it is final. An import that gave the source another URL meanwhile voids it.
 */
async function recordSourceError(ctx: ReconcileContext, table: SourceTable, row: SourceRow, error: SourceError) {
    await db.transaction(async (tx) => {
        await lockPosts(tx, { mediaIds: [ctx.subjectId] });
        await tx
            .update(table)
            .set({
                status: error.retryable ? SyncStatus.PENDING : SyncStatus.FAILED,
                last_error: error.message,
                error_kind: error.kind,
                error_source_url: row.source_url,
                update_time: Temporal.Now.instant(),
            })
            .where(and(eq(table.id, row.id), eq(table.source_url, row.source_url!), ne(table.status, SyncStatus.COMPLETED)));
        await refreshMediaSyncStatus(tx, [ctx.subjectId]);
        await ctx.fence(tx);
    });
}

const failedMedia = (libraryIds: readonly string[]) =>
    and(
        inArray(Media.library_id, [...libraryIds]),
        eq(Media.delete_status, DeleteStatus.ACTIVE),
        isNull(Media.recycle_time),
        eq(Media.sync_status, SyncStatus.FAILED),
    );

const SOURCE_TABLES = [MediaOriginal, MediaCaption, MediaCover] as const;

/**
 * `download`: fetches the imported sources of a media into storage: its originals, which are probed, its captions,
 * which are converted to WebVTT, and its cover. Every write to a source refreshes the status of the media and its post
 * (refreshMediaSyncStatus). Content and cover changes are reported as they land, which queues the previews.
 */
export const downloadPipeline: SubjectPipelineHandler = {
    // A run may take up to two hours; without a limit, slow downloads could fill every slot of the worker.
    concurrency: 4,
    // A large source takes a long time on a slow link; one that stalls fails the idle read timeout long before this.
    timeoutMs: 2 * 60 * 60_000,

    async reconcile(ctx) {
        const [media] = await db.select().from(Media).where(activeMedia(ctx.subjectId)).limit(1);
        if (!media) return { kind: "done" };

        const [originals, captions, covers] = await Promise.all([
            db
                .select()
                .from(MediaOriginal)
                .where(and(eq(MediaOriginal.media_id, media.id), pendingSource(MediaOriginal)))
                .orderBy(asc(MediaOriginal.create_time)),
            db
                .select()
                .from(MediaCaption)
                .where(and(eq(MediaCaption.media_id, media.id), pendingSource(MediaCaption)))
                .orderBy(asc(MediaCaption.create_time)),
            db
                .select()
                .from(MediaCover)
                .where(and(eq(MediaCover.media_id, media.id), pendingSource(MediaCover))),
        ]);

        // A final error ends its source FAILED at once and the others still run; one that may pass later retries the media.
        let retry: ReconcileResult | undefined;
        const attempt = async (table: SourceTable, row: SourceRow, download: () => Promise<void>) => {
            await startSource(ctx, table, row);
            try {
                await download();
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                const sourceError = classifySourceError(error);
                await recordSourceError(ctx, table, row, sourceError);
                if (sourceError.retryable) retry ??= { kind: "retry", error: sourceError.message, errorKind: sourceError.kind };
            }
        };
        for (const original of originals) await attempt(MediaOriginal, original, () => downloadOriginal(ctx, media, original));
        for (const caption of captions) await attempt(MediaCaption, caption, () => downloadCaption(ctx, media, caption));
        for (const cover of covers) await attempt(MediaCover, cover, () => downloadCover(ctx, media, cover));
        if (retry) return retry;

        // Also settles a media queued with nothing left to download, such as one an import changed.
        await db.transaction(async (tx) => {
            await refreshMediaSyncStatus(tx, [media.id]);
            await ctx.fence(tx);
        });
        return { kind: "done" };
    },

    /**
     * Fails the sources still waiting for a download, which fails the media, so scans leave them until a retry or a new
     * URL. A source keeps the error its own last attempt recorded; one without takes the run's.
     */
    async recordFailure(tx, { subjectId: mediaId, error, errorKind }) {
        await lockPosts(tx, { mediaIds: [mediaId] });
        const [media] = await tx.select({ id: Media.id }).from(Media).where(activeMedia(mediaId)).limit(1);
        if (!media) return;
        for (const table of SOURCE_TABLES) {
            await tx
                .update(table)
                .set({
                    status: SyncStatus.FAILED,
                    last_error: sql`coalesce(${table.last_error}, ${error})`,
                    error_kind: sql`coalesce(${table.error_kind}, ${errorKind ?? SourceErrorKind.INTERNAL}::source_error_kind)`,
                    error_source_url: sql`${table.source_url}`,
                    update_time: Temporal.Now.instant(),
                })
                .where(and(eq(table.media_id, mediaId), pendingSource(table)));
        }
        await refreshMediaSyncStatus(tx, [mediaId]);
    },

    /** A media is retried when one of its sources failed for a retryable reason; the others fail it again anyway. */
    async resetFailures(tx, mediaIds) {
        await lockPosts(tx, { mediaIds });
        const retried = await resetRetryableSources(tx, mediaIds);
        await refreshMediaSyncStatus(tx, retried);
        return retried;
    },

    async scanPage(libraryId, cursor, limit) {
        const conditions = [eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)];
        if (cursor) conditions.push(gt(Media.id, cursor));
        const page = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(...conditions))
            .orderBy(asc(Media.id))
            .limit(limit);
        if (page.length === 0) return { subjectIds: [], nextCursor: null };

        const pending = await db
            .select({ id: Media.id })
            .from(Media)
            .where(
                and(
                    inArray(
                        Media.id,
                        page.map((media) => media.id),
                    ),
                    or(
                        ...SOURCE_TABLES.map((table) =>
                            exists(
                                db
                                    .select({ id: table.id })
                                    .from(table)
                                    .where(and(eq(table.media_id, Media.id), pendingSource(table))),
                            ),
                        ),
                    ),
                ),
            );
        return {
            subjectIds: pending.map((media) => media.id),
            nextCursor: page.length === limit ? page[page.length - 1]!.id : null,
        };
    },

    async countFailures(libraryIds) {
        if (libraryIds.length === 0) return new Map();
        const rows = await db
            .select({ libraryId: Media.library_id, count: sql<number>`count(*)::int` })
            .from(Media)
            .where(failedMedia(libraryIds))
            .groupBy(Media.library_id);
        return new Map(rows.map((row) => [row.libraryId, row.count]));
    },

    async listFailures(libraryId, limit) {
        const query = db
            .select({ subjectId: Media.id, label: Media.title, error: Media.last_error, time: Media.update_time })
            .from(Media)
            .where(failedMedia([libraryId]))
            .orderBy(desc(Media.update_time))
            .$dynamic();
        const rows = limit === undefined ? await query : await query.limit(limit);
        return rows.map((row) => ({ ...row, error: row.error ?? "" }));
    },
};
