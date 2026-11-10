import { and, asc, desc, eq, exists, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { DeleteStatus, File, Media, MediaCaption, MediaCover, MediaOriginal, SyncStatus } from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { env } from "@/global/env";
import { convertToVtt, makeDefaultCaption, storeVtt } from "@/features/media/captions";
import { getMediaCompletionError, refreshPostSyncStatus } from "@/features/media/composition";
import { completeOriginal } from "@/features/media/originals";
import { probeOriginal, ProbeRejectedError } from "@/features/media/probe";
import { mediaStoragePath } from "@/features/media/storage";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { ReconcileContext, ReconcileResult, SubjectPipelineHandler } from "@/infra/queue/types";
import { getErrorMessage } from "@/lib/utils/error";
import { DownloadStatusError, downloadStream, getBodyLength, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";

type MediaRow = typeof Media.$inferSelect;
type OriginalRow = typeof MediaOriginal.$inferSelect;
type CaptionRow = typeof MediaCaption.$inferSelect;
type CoverRow = typeof MediaCover.$inferSelect;

const activeMedia = (mediaId: string) =>
    and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

/**
 * An imported source still waiting for its download: FAILED ones failed on it and run only when the media is
 * requeued. Originals, captions and covers share the shape.
 */
function pendingSource(table: typeof MediaOriginal | typeof MediaCaption | typeof MediaCover, failedToo: boolean): SQL {
    return and(
        isNotNull(table.source_url),
        failedToo ? ne(table.status, SyncStatus.COMPLETED) : inArray(table.status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS]),
    )!;
}

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

/** Downloads a source into storage under `media`, as `<prefix>_<key>.<ext>`, and records its file. */
async function fetchSource(ctx: ReconcileContext, media: MediaRow, source: { source_url: string | null; source_key: string | null }, prefix: string) {
    const sourceUrl = source.source_url!;
    const response = await downloadStream(sourceUrl, { signal: ctx.signal });
    if (!response?.body) throw new Error(`Download of ${sourceUrl} returned no body`);
    ctx.signal.throwIfAborted();

    const contentType = response.headers.get("Content-Type") || "application/octet-stream";
    const size = getBodyLength(response) ?? null;
    const ext = getExtensionFromContentType(contentType, sourceUrl);
    const path = mediaStoragePath(media, `${prefix}_${keyName(source.source_key!)}.${ext}`);
    await uploadToS3(path, response.body, contentType, env.S3_BUCKET, size ?? undefined, ctx.signal);
    ctx.signal.throwIfAborted();
    return upsertFile(db, { path, mime_type: contentType, extension: ext, size });
}

/** Downloads and probes one original, then completes it unless the import replaced or removed it meanwhile. */
async function downloadOriginal(ctx: ReconcileContext, media: MediaRow, original: OriginalRow): Promise<void> {
    await db.transaction(async (tx) => {
        await tx.update(MediaOriginal).set({ status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() }).where(eq(MediaOriginal.id, original.id));
        await ctx.fence(tx);
    });
    const file = await fetchSource(ctx, media, original, "original");
    let probe;
    try {
        probe = await probeOriginal(file);
    } catch (error) {
        await softDeleteFile(db, file.id);
        throw error;
    }

    await db.transaction(async (tx) => {
        const [current] = await tx
            .select({ id: MediaOriginal.id })
            .from(MediaOriginal)
            .where(and(eq(MediaOriginal.id, original.id), eq(MediaOriginal.source_key, original.source_key!)))
            .for("update");
        if (!current) return softDeleteFile(tx, file.id);
        await completeOriginal(tx, media, original.id, file.id, probe);
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
        const [current] = await tx
            .select({ id: MediaCaption.id, is_default: MediaCaption.is_default })
            .from(MediaCaption)
            .where(and(eq(MediaCaption.id, caption.id), eq(MediaCaption.source_key, caption.source_key!)))
            .for("update");
        if (!current) return softDeleteFile(tx, file.id);
        const vttFileId = await storeVtt(tx, media, keyName(caption.source_key!), vtt);
        await tx
            .update(MediaCaption)
            .set({ source_file_id: file.id, vtt_file_id: vttFileId, status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() })
            .where(eq(MediaCaption.id, caption.id));
        if (current.is_default) await makeDefaultCaption(tx, media.id, caption.id);
        await ctx.fence(tx);
        await markChanged(tx, Aspect.MEDIA_CONTENT, [media.id]);
    });
}

/**
 * Downloads the imported cover into storage and completes it, unless the import replaced its source meanwhile. The
 * object is named after its source URL, so a new cover never overwrites one a CDN may still serve.
 */
async function downloadCover(ctx: ReconcileContext, media: MediaRow, cover: CoverRow): Promise<void> {
    const file = await fetchSource(ctx, media, cover, "cover");
    await db.transaction(async (tx) => {
        const completed = await tx
            .update(MediaCover)
            .set({ file_id: file.id, status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() })
            .where(and(eq(MediaCover.id, cover.id), eq(MediaCover.source_key, cover.source_key!)))
            .returning({ id: MediaCover.id });
        if (completed.length === 0) return softDeleteFile(tx, file.id);
        await ctx.fence(tx);
        await markChanged(tx, Aspect.MEDIA_COVER, [media.id]);
    });
}

/** Records a failed download on its row, unless the import replaced the source meanwhile. */
async function recordSourceError(
    ctx: ReconcileContext,
    table: typeof MediaOriginal | typeof MediaCaption | typeof MediaCover,
    row: { id: string; source_key: string | null },
    status: SyncStatus,
    error: string,
) {
    await db.transaction(async (tx) => {
        await tx
            .update(table)
            .set({ status, last_error: error, update_time: Temporal.Now.instant() })
            .where(and(eq(table.id, row.id), eq(table.source_key, row.source_key!), ne(table.status, SyncStatus.COMPLETED)));
        await ctx.fence(tx);
    });
}

async function setMediaFailed(tx: Transaction, media: Pick<MediaRow, "id" | "post_id">, error: string) {
    const now = Temporal.Now.instant();
    await tx.update(Media).set({ sync_status: SyncStatus.FAILED, last_error: error, update_time: now }).where(activeMedia(media.id));
    if (media.post_id) await refreshPostSyncStatus(tx, media.post_id, now);
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
 * which are converted to WebVTT, and its cover. Once every original is complete and they make up the media, the media
 * is complete. Content and cover changes are reported as they land, which queues the previews.
 */
export const downloadPipeline: SubjectPipelineHandler = {
    // A large source takes a long time on a slow link; one that stalls fails the idle read timeout long before this.
    timeoutMs: 2 * 60 * 60_000,

    async reconcile(ctx) {
        const [media] = await db.select().from(Media).where(activeMedia(ctx.subjectId)).limit(1);
        if (!media) return { kind: "done" };

        const [originals, captions, covers] = await Promise.all([
            db
                .select()
                .from(MediaOriginal)
                .where(and(eq(MediaOriginal.media_id, media.id), pendingSource(MediaOriginal, true)))
                .orderBy(asc(MediaOriginal.create_time)),
            db
                .select()
                .from(MediaCaption)
                .where(and(eq(MediaCaption.media_id, media.id), pendingSource(MediaCaption, true)))
                .orderBy(asc(MediaCaption.create_time)),
            db
                .select()
                .from(MediaCover)
                .where(and(eq(MediaCover.media_id, media.id), pendingSource(MediaCover, true))),
        ]);

        if (originals.length + captions.length + covers.length > 0) {
            await db.transaction(async (tx) => {
                await tx
                    .update(Media)
                    .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                    .where(activeMedia(media.id));
                await ctx.fence(tx);
            });
        }

        let failure: ReconcileResult | undefined;
        const attempt = async (
            table: (typeof SOURCE_TABLES)[number],
            row: { id: string; source_key: string | null },
            download: () => Promise<void>,
        ) => {
            try {
                await download();
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                // A source the platform refuses, or a file the tools cannot read, will not work on a retry.
                const rejected = (error instanceof DownloadStatusError && error.rejected) || error instanceof ProbeRejectedError;
                const message = getErrorMessage(error);
                await recordSourceError(ctx, table, row, rejected ? SyncStatus.FAILED : SyncStatus.PENDING, message);
                // Any source that may still work keeps the media retrying.
                if (!failure || !rejected) failure = { kind: rejected ? "rejected" : "retry", error: message };
            }
        };
        for (const original of originals) await attempt(MediaOriginal, original, () => downloadOriginal(ctx, media, original));
        for (const caption of captions) await attempt(MediaCaption, caption, () => downloadCaption(ctx, media, caption));
        for (const cover of covers) await attempt(MediaCover, cover, () => downloadCover(ctx, media, cover));
        if (failure) return failure;

        await db.transaction(async (tx) => {
            const completionError = await getMediaCompletionError(tx, media);
            if (completionError) {
                await setMediaFailed(tx, media, completionError);
                await ctx.fence(tx);
                return;
            }
            const now = Temporal.Now.instant();
            await tx
                .update(Media)
                .set({ sync_status: SyncStatus.COMPLETED, last_error: null, update_time: now })
                .where(and(activeMedia(media.id), ne(Media.sync_status, SyncStatus.COMPLETED)));
            if (media.post_id) await refreshPostSyncStatus(tx, media.post_id, now);
            await ctx.fence(tx);
        });
        return { kind: "done" };
    },

    /** Marks the media failed, and its sources still waiting for a download too, so scans leave them until a requeue. */
    async recordFailure(tx, { subjectId: mediaId, error }) {
        const [media] = await tx.select({ id: Media.id, post_id: Media.post_id }).from(Media).where(activeMedia(mediaId)).limit(1);
        if (!media) return;
        for (const table of SOURCE_TABLES) {
            await tx
                .update(table)
                .set({ status: SyncStatus.FAILED, update_time: Temporal.Now.instant() })
                .where(and(eq(table.media_id, mediaId), pendingSource(table, false)));
        }
        await setMediaFailed(tx, media, error);
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
                                    .where(and(eq(table.media_id, Media.id), pendingSource(table, false))),
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
