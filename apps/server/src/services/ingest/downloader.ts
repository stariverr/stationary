import { db } from "@/global/db";
import {
    Post,
    Media,
    Track,
    Author,
    File,
    DeleteStatus,
    SyncStatus,
    TrackType,
    TrackPurpose,
    MediaType,
    AsyncTaskType,
} from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { downloadStream, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";
import { extractSegmentBase } from "@/lib/utils/mp4-segment";
import { withLock } from "@/lib/utils/lock";
import { env } from "@/global/env";
import { JobManager } from "@/infra/jobs/manager";
import { Temporal } from "@js-temporal/polyfill";
import { deriveTrackFormat } from "@/lib/utils/track-format";
import { MediaService } from "@/services/media";

export async function processMediaById(mediaId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const mediaRecords = await db
        .select()
        .from(Media)
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .limit(1);
    const m = mediaRecords[0];
    if (!m) return;
    return processMedia(m.id, signal);
}

export async function processMedia(mediaId: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const mediaRecords = await db
        .select()
        .from(Media)
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .limit(1);
    const m = mediaRecords[0];
    if (!m) return;

    const lockKey = `lock:media:${m.id}`;

    await withLock(
        lockKey,
        async (lockSignal) => {
            try {
                lockSignal.throwIfAborted();
                await db
                    .update(Media)
                    .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                    .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                const tracks = await db
                    .select()
                    .from(Track)
                    .where(and(eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                let allCompleted = true;

                for (const mf of tracks) {
                    lockSignal.throwIfAborted();
                    if (mf.sync_status === SyncStatus.COMPLETED || !mf.source_url) continue;

                    const [activeMedia] = await db
                        .select({ id: Media.id })
                        .from(Media)
                        .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                        .limit(1);
                    if (!activeMedia) return;

                    const [activeTrack] = await db
                        .select({ id: Track.id })
                        .from(Track)
                        .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                        .limit(1);
                    if (!activeTrack) continue;

                    await db
                        .update(Track)
                        .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                        .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));

                    try {
                        const response = await downloadStream(mf.source_url, { signal: lockSignal });
                        if (response) {
                            lockSignal.throwIfAborted();
                            let contentType = response.headers.get("Content-Type");
                            let contentLength = response.headers.get("Content-Length");
                            let ext = getExtensionFromContentType(contentType, mf.source_url);
                            let responseBody: ReadableStream | Uint8Array;

                            if (!response.body) {
                                throw new Error("Response body is empty");
                            }
                            responseBody = response.body;

                            let segmentBase: { initialization: string; index_range: string } | undefined;
                            if (
                                (mf.type === TrackType.VIDEO || mf.type === TrackType.AUDIO) &&
                                responseBody instanceof ReadableStream
                            ) {
                                const res = await extractSegmentBase(responseBody);
                                segmentBase = res.segment_base;
                                responseBody = res.stream;
                            }

                            let prefix = "";
                            if (mf.type === TrackType.VIDEO && mf.purpose === TrackPurpose.CONTENT) {
                                prefix = `video_${mf.variant_key}`;
                            } else if (mf.type === TrackType.AUDIO && mf.purpose === TrackPurpose.CONTENT) {
                                prefix = `audio_${mf.variant_key}`;
                            } else if (mf.purpose === TrackPurpose.COVER) {
                                prefix = "cover";
                            } else if (mf.type === TrackType.SUBTITLE && mf.purpose === TrackPurpose.CONTENT) {
                                prefix = `subtitle_${mf.variant_key}`;
                            } else if (mf.type === TrackType.IMAGE && mf.purpose === TrackPurpose.CONTENT) {
                                prefix = `image_${mf.variant_key}`;
                            } else {
                                prefix = `track_${mf.variant_key}`;
                            }

                            const path = m.post_id
                                ? `v2/p/${m.post_id.slice(-2)}/${m.post_id}/media_${m.id}/${prefix}.${ext}`
                                : `v2/m/${m.id.slice(-2)}/${m.id}/${prefix}.${ext}`;

                            const S3Data = responseBody;
                            await uploadToS3(
                                path,
                                S3Data,
                                contentType || "application/octet-stream",
                                env.S3_BUCKET,
                                contentLength ? parseInt(contentLength) : undefined,
                                lockSignal,
                            );
                            lockSignal.throwIfAborted();

                            const [activeTrackBeforePersist] = await db
                                .select({ id: Track.id })
                                .from(Track)
                                .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                                .limit(1);
                            if (!activeTrackBeforePersist) return;

                            const size = contentLength ? parseInt(contentLength) : null;

                            const fileResults = await db
                                .insert(File)
                                .values({
                                    path: path,
                                    mime_type: contentType || "application/octet-stream",
                                    extension: ext,
                                    bucket: env.S3_BUCKET,
                                    size: size,
                                })
                                .onConflictDoUpdate({
                                    target: File.path,
                                    set: {
                                        mime_type: contentType || "application/octet-stream",
                                        extension: ext,
                                        size: size,
                                        delete_status: DeleteStatus.ACTIVE,
                                        delete_time: null,
                                    },
                                })
                                .returning({ id: File.id });

                            const updatedMetadata = {
                                ...mf.metadata,
                            };
                            if (segmentBase) {
                                updatedMetadata.segment_base = segmentBase;
                            }
                            const format = deriveTrackFormat({
                                type: mf.type,
                                metadata: updatedMetadata,
                                container: mf.container,
                                is_fragmented: mf.is_fragmented,
                                stream_layout: mf.stream_layout,
                                has_video: mf.has_video,
                                has_audio: mf.has_audio,
                                streams: mf.streams,
                                file: {
                                    mime_type: contentType,
                                    extension: ext,
                                },
                            });

                            const width = mf.width;
                            const height = mf.height;
                            const duration = mf.duration;
                            const bandwidth = mf.bandwidth;

                            const updatedTracks = await db
                                .update(Track)
                                .set({
                                    file_id: fileResults[0].id,
                                    sync_status: SyncStatus.COMPLETED,
                                    last_error: null,
                                    metadata: updatedMetadata,
                                    container: format.container,
                                    is_fragmented: format.is_fragmented,
                                    stream_layout: format.stream_layout,
                                    has_video: format.has_video,
                                    has_audio: format.has_audio,
                                    streams: format.streams,
                                    width: width,
                                    height: height,
                                    duration: duration,
                                    bandwidth: bandwidth,
                                    update_time: Temporal.Now.instant(),
                                })
                                .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                                .returning({ id: Track.id });

                            if (updatedTracks.length === 0) {
                                await db
                                    .update(File)
                                    .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                                    .where(and(eq(File.id, fileResults[0].id), eq(File.delete_status, DeleteStatus.ACTIVE)));
                                return;
                            }
                            if (mf.file_id && mf.file_id !== fileResults[0].id) {
                                await db
                                    .update(File)
                                    .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                                    .where(and(eq(File.id, mf.file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
                            }
                        }
                    } catch (e) {
                        if (lockSignal.aborted) throw e;
                        const errorMsg = e instanceof Error ? e.message : String(e);
                        await db
                            .update(Track)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: errorMsg,
                                update_time: Temporal.Now.instant(),
                            })
                            .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                        allCompleted = false;
                        throw e;
                    }
                }

                const completionError = await MediaService.getMediaCompletionError(m.id, true);
                if (allCompleted && !completionError) {
                    lockSignal.throwIfAborted();
                    await db
                        .update(Media)
                        .set({ sync_status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() })
                        .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                    if (m.type === MediaType.IMAGE || m.type === MediaType.LIVE_PHOTO || m.type === MediaType.VIDEO) {
                        try {
                            await JobManager.createTask({
                                type: AsyncTaskType.COVER_BATCH,
                                libraryId: m.library_id,
                                inputSnapshot: {
                                    source_type: "MANUAL",
                                    media_ids: [m.id],
                                },
                            });
                        } catch (coverErr) {
                            console.error(`[COVER_SERVICE] Failed to schedule cover job for media ${m.id}:`, coverErr);
                        }
                    }
                } else {
                    await db
                        .update(Media)
                        .set({
                            sync_status: SyncStatus.FAILED,
                            last_error: completionError ?? "Some files failed to process",
                            update_time: Temporal.Now.instant(),
                        })
                        .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                    if (m.post_id) {
                        await db
                            .update(Post)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: `Media item ${m.id} failed to process: ${completionError ?? "Some files failed to process"}`,
                                update_time: Temporal.Now.instant(),
                            })
                            .where(and(eq(Post.id, m.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
                    }
                }
            } catch (e) {
                if (lockSignal.aborted) throw e;
                const errorMsg = e instanceof Error ? e.message : String(e);
                await db
                    .update(Media)
                    .set({ sync_status: SyncStatus.FAILED, last_error: errorMsg, update_time: Temporal.Now.instant() })
                    .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                if (m.post_id) {
                    await db
                        .update(Post)
                        .set({
                            sync_status: SyncStatus.FAILED,
                            last_error: `Media item ${m.id} failed to process: ${errorMsg}`,
                            update_time: Temporal.Now.instant(),
                        })
                        .where(and(eq(Post.id, m.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
                }

                throw e;
            }
        },
        { ttl: 300, signal },
    );
}

export async function processAvatar(authorId: string, avatarUrl: string, signal?: AbortSignal) {
    const lockKey = `lock:avatar:${authorId}`;

    await withLock(
        lockKey,
        async (lockSignal) => {
            lockSignal.throwIfAborted();
            const authorData = await db.select().from(Author).where(eq(Author.id, authorId));
            const currentAuthor = authorData[0];

            if (currentAuthor && !currentAuthor.avatar_file_id) {
                const avatarResponse = await downloadStream(avatarUrl, { signal: lockSignal });
                if (avatarResponse && avatarResponse.body) {
                    lockSignal.throwIfAborted();
                    const avatarContentType = avatarResponse.headers.get("Content-Type");
                    const avatarContentLength = avatarResponse.headers.get("Content-Length");
                    const ext = getExtensionFromContentType(avatarContentType, avatarUrl);
                    const path = `v2/a/${authorId.slice(-2)}/${authorId}/original.${ext}`;

                    await uploadToS3(
                        path,
                        avatarResponse.body,
                        avatarContentType || "application/octet-stream",
                        env.S3_BUCKET,
                        avatarContentLength ? parseInt(avatarContentLength) : undefined,
                        lockSignal,
                    );
                    lockSignal.throwIfAborted();

                    const fileResults = await db
                        .insert(File)
                        .values({
                            path: path,
                            mime_type: avatarContentType || "application/octet-stream",
                            extension: ext,
                            bucket: env.S3_BUCKET,
                            size: avatarContentLength ? parseInt(avatarContentLength) : null,
                        })
                        .onConflictDoUpdate({
                            target: File.path,
                            set: {
                                mime_type: avatarContentType || "application/octet-stream",
                                extension: ext,
                                size: avatarContentLength ? parseInt(avatarContentLength) : null,
                                delete_status: DeleteStatus.ACTIVE,
                                delete_time: null,
                            },
                        })
                        .returning({ id: File.id });

                    await db.update(Author).set({ avatar_file_id: fileResults[0].id }).where(eq(Author.id, authorId));
                }
            }
        },
        { ttl: 120, signal },
    );
}
