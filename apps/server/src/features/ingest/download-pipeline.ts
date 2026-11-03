import { and, asc, desc, eq, exists, gt, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { DeleteStatus, File, Media, SyncStatus, Track, TrackPurpose, TrackType } from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { env } from "@/global/env";
import { getMediaCompletionError, refreshPostSyncStatus } from "@/features/media/composition";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { ReconcileContext, ReconcileResult, SubjectPipelineHandler } from "@/infra/queue/types";
import { getErrorMessage } from "@/lib/utils/error";
import { DownloadStatusError, downloadStream, getBodyLength, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";
import { extractSegmentBase } from "@/lib/utils/mp4-segment";
import { deriveTrackFormat } from "@/lib/utils/track-format";

type MediaRow = typeof Media.$inferSelect;
type TrackRow = typeof Track.$inferSelect;

const activeMedia = (mediaId: string) =>
    and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));
const activeTrack = (track: Pick<TrackRow, "id" | "media_id">) =>
    and(eq(Track.id, track.id), eq(Track.media_id, track.media_id), eq(Track.delete_status, DeleteStatus.ACTIVE));

/** A track still waiting for its remote source; FAILED tracks failed on it and run only when the media is requeued. */
const pendingSourceTrack = (failedToo: boolean): SQL =>
    and(
        eq(Track.delete_status, DeleteStatus.ACTIVE),
        ne(Track.source_url, ""),
        failedToo ? ne(Track.sync_status, SyncStatus.COMPLETED) : inArray(Track.sync_status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS]),
    )!;

function storagePath(media: MediaRow, track: TrackRow, ext: string): string {
    let prefix: string;
    if (track.type === TrackType.VIDEO && track.purpose === TrackPurpose.CONTENT) prefix = `video_${track.variant_key}`;
    else if (track.type === TrackType.AUDIO && track.purpose === TrackPurpose.CONTENT) prefix = `audio_${track.variant_key}`;
    else if (track.purpose === TrackPurpose.COVER) prefix = "cover";
    else if (track.type === TrackType.SUBTITLE && track.purpose === TrackPurpose.CONTENT) prefix = `subtitle_${track.variant_key}`;
    else if (track.type === TrackType.IMAGE && track.purpose === TrackPurpose.CONTENT) prefix = `image_${track.variant_key}`;
    else prefix = `track_${track.variant_key}`;

    return media.post_id
        ? `v2/p/${media.post_id.slice(-2)}/${media.post_id}/media_${media.id}/${prefix}.${ext}`
        : `v2/m/${media.id.slice(-2)}/${media.id}/${prefix}.${ext}`;
}

/** Downloads one track's source into storage and points the track at the new file. */
async function downloadTrack(ctx: ReconcileContext, media: MediaRow, track: TrackRow): Promise<void> {
    const sourceUrl = track.source_url!;
    await db.transaction(async (tx) => {
        await tx.update(Track).set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() }).where(activeTrack(track));
        await ctx.fence(tx);
    });

    const response = await downloadStream(sourceUrl, { signal: ctx.signal });
    if (!response?.body) throw new Error(`Download of ${sourceUrl} returned no body`);
    ctx.signal.throwIfAborted();

    const contentType = response.headers.get("Content-Type");
    const size = getBodyLength(response) ?? null;
    const ext = getExtensionFromContentType(contentType, sourceUrl);

    let body: ReadableStream = response.body;
    let segmentBase: { initialization: string; index_range: string } | undefined;
    if (track.type === TrackType.VIDEO || track.type === TrackType.AUDIO) {
        const extracted = await extractSegmentBase(body);
        segmentBase = extracted.segment_base;
        body = extracted.stream;
    }

    const path = storagePath(media, track, ext);
    await uploadToS3(path, body, contentType || "application/octet-stream", env.S3_BUCKET, size ?? undefined, ctx.signal);
    ctx.signal.throwIfAborted();

    await db.transaction(async (tx) => {
        const [current] = await tx.select({ file_id: Track.file_id }).from(Track).where(activeTrack(track)).limit(1);
        if (!current) return;

        const [file] = await tx
            .insert(File)
            .values({ path, mime_type: contentType || "application/octet-stream", extension: ext, bucket: env.S3_BUCKET, size })
            .onConflictDoUpdate({
                target: File.path,
                set: {
                    mime_type: contentType || "application/octet-stream",
                    extension: ext,
                    size,
                    delete_status: DeleteStatus.ACTIVE,
                    delete_time: null,
                },
            })
            .returning({ id: File.id });

        const metadata = segmentBase ? { ...track.metadata, segment_base: segmentBase } : { ...track.metadata };
        const format = deriveTrackFormat({
            type: track.type,
            metadata,
            container: track.container,
            is_fragmented: track.is_fragmented,
            stream_layout: track.stream_layout,
            has_video: track.has_video,
            has_audio: track.has_audio,
            streams: track.streams,
            file: { mime_type: contentType, extension: ext },
        });

        await tx
            .update(Track)
            .set({
                file_id: file!.id,
                sync_status: SyncStatus.COMPLETED,
                last_error: null,
                metadata,
                container: format.container,
                is_fragmented: format.is_fragmented,
                stream_layout: format.stream_layout,
                has_video: format.has_video,
                has_audio: format.has_audio,
                streams: format.streams,
                update_time: Temporal.Now.instant(),
            })
            .where(activeTrack(track));

        if (current.file_id && current.file_id !== file!.id) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                .where(and(eq(File.id, current.file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }
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

/**
 * `download`: fetches the remote sources of a media's content tracks into storage. Once every required track has a
 * file, the media is complete and its content is reported as changed (which queues the cover).
 */
export const downloadPipeline: SubjectPipelineHandler = {
    // A large source takes a long time on a slow link; one that stalls fails the idle read timeout long before this.
    timeoutMs: 2 * 60 * 60_000,

    async reconcile(ctx) {
        const [media] = await db.select().from(Media).where(activeMedia(ctx.subjectId)).limit(1);
        if (!media) return { kind: "done" };

        const tracks = await db
            .select()
            .from(Track)
            .where(and(eq(Track.media_id, media.id), pendingSourceTrack(true)));

        if (tracks.length > 0) {
            await db.transaction(async (tx) => {
                await tx
                    .update(Media)
                    .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                    .where(activeMedia(media.id));
                await ctx.fence(tx);
            });
        }

        let failure: ReconcileResult | undefined;
        for (const track of tracks) {
            try {
                await downloadTrack(ctx, media, track);
            } catch (error) {
                if (ctx.signal.aborted) throw error;
                const rejected = error instanceof DownloadStatusError && error.rejected;
                const message = getErrorMessage(error);
                await db.transaction(async (tx) => {
                    await tx
                        .update(Track)
                        .set({
                            sync_status: rejected ? SyncStatus.FAILED : SyncStatus.PENDING,
                            last_error: message,
                            update_time: Temporal.Now.instant(),
                        })
                        .where(activeTrack(track));
                    await ctx.fence(tx);
                });
                // Any track that may still work keeps the media retrying.
                if (!failure || !rejected) failure = { kind: rejected ? "rejected" : "retry", error: message };
            }
        }
        if (failure) return failure;

        await db.transaction(async (tx) => {
            const completionError = await getMediaCompletionError(media.id, true, tx);
            if (completionError) {
                await setMediaFailed(tx, media, completionError);
                await ctx.fence(tx);
                return;
            }
            const now = Temporal.Now.instant();
            const completed = await tx
                .update(Media)
                .set({ sync_status: SyncStatus.COMPLETED, last_error: null, update_time: now })
                .where(and(activeMedia(media.id), ne(Media.sync_status, SyncStatus.COMPLETED)))
                .returning({ id: Media.id });
            if (media.post_id) await refreshPostSyncStatus(tx, media.post_id, now);
            await ctx.fence(tx);
            if (completed.length > 0 || tracks.length > 0) await markChanged(tx, Aspect.MEDIA_CONTENT, [media.id]);
        });
        return { kind: "done" };
    },

    /** Marks the media failed, and its tracks still waiting for a source too, so scans leave them until a requeue. */
    async recordFailure(tx, { subjectId: mediaId, error }) {
        const [media] = await tx.select({ id: Media.id, post_id: Media.post_id }).from(Media).where(activeMedia(mediaId)).limit(1);
        if (!media) return;
        await tx
            .update(Track)
            .set({ sync_status: SyncStatus.FAILED, update_time: Temporal.Now.instant() })
            .where(and(eq(Track.media_id, mediaId), pendingSourceTrack(false)));
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
                    exists(
                        db
                            .select({ id: Track.id })
                            .from(Track)
                            .where(and(eq(Track.media_id, Media.id), pendingSourceTrack(false))),
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
