import { db } from "@/global/db";
import { and, eq, lt, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
    Media,
    MediaFile,
    File,
    DeleteStatus,
    SyncStatus,
    MediaFileRole,
    MediaType,
} from "@/db/schema";
import { env } from "@/global/env";
import { Client } from "@upstash/workflow";
import { s3 } from "@/global/s3";
import { extractVideoFrame } from "@/lib/utils/ffmpeg";
import { uploadToS3 } from "@/lib/utils/media";
import { Temporal } from "@js-temporal/polyfill";
import { nowDbTimestamp } from "@/lib/utils/time";
import { withLock } from "@/lib/utils/lock";
import { buildCdnUrl } from "@/lib/utils/cdn";

export type RequestVideoCoverOptions = {
    originUrl?: string;
    force?: boolean;
    replaceExternalCover?: boolean;
};

export type VideoCoverRequestResult =
    | {
          status: "queued";
          mediaId: string;
      }
    | {
          status: "skipped";
          mediaId: string;
          reason: string;
      }
    | {
          status: "already_pending";
          mediaId: string;
      };

export type ScanMissingCoversOptions = {
    libraryId?: string;
    originUrl?: string;
    limit?: number;
    staleMinutes?: number;
};

export type ScanMissingCoversResult = {
    scanned: number;
    matched: number;
    queued: number;
    skipped: number;
    alreadyPending: number;
    failed: number;
    hasMore: boolean;
    failures: Array<{
        mediaId: string;
        error: string;
    }>;
    locked?: boolean;
};

export const VideoCoverService = {
    /**
     * Entrypoint to request a generated video cover.
     * Evaluates state, checks cache/re-generation requirements, and enqueues QStash background job.
     */
    async requestForMedia(
        mediaId: string,
        options?: RequestVideoCoverOptions,
    ): Promise<VideoCoverRequestResult> {
        // 1. Fetch media
        const mediaResults = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        const media = mediaResults[0];
        if (!media || media.type !== "VIDEO") {
            return {
                status: "skipped",
                mediaId,
                reason: "media_not_found_or_not_video",
            };
        }

        // 2. Fetch existing primary & cover
        const mediaFiles = await db
            .select()
            .from(MediaFile)
            .where(
                and(
                    eq(MediaFile.media_id, mediaId),
                    eq(MediaFile.delete_status, DeleteStatus.ACTIVE),
                ),
            );
        const primary = mediaFiles.find((mf) => mf.role === "PRIMARY");
        const cover = mediaFiles.find((mf) => mf.role === MediaFileRole.COVER);

        if (!primary || primary.sync_status !== "COMPLETED" || !primary.file_id) {
            console.log(
                `[VideoCoverService] Primary file is not fully synced yet for media ${mediaId}.`,
            );
            return {
                status: "skipped",
                mediaId,
                reason: "primary_file_not_synced",
            };
        }

        // Check if there is a valid active cover
        const hasExternalCover = cover && !!cover.source_url;
        if (hasExternalCover && options?.replaceExternalCover !== true) {
            console.log(
                `[VideoCoverService] Media ${mediaId} has an external cover and replaceExternalCover is not set. Skipping.`,
            );
            return {
                status: "skipped",
                mediaId,
                reason: "external_cover_exists",
            };
        }

        // Check if cover is already pending or in progress
        const isStaleTime = Temporal.Now.instant().subtract({ minutes: 15 });
        if (
            cover &&
            (cover.sync_status === SyncStatus.PENDING ||
                cover.sync_status === SyncStatus.IN_PROGRESS) &&
            cover.update_time &&
            Temporal.Instant.compare(cover.update_time, isStaleTime) >= 0
        ) {
            console.log(
                `[VideoCoverService] Media ${mediaId} cover generation task is already pending. Skipping.`,
            );
            return {
                status: "already_pending",
                mediaId,
            };
        }

        // If not forced, check if a valid generated/completed cover already exists
        if (!options?.force) {
            const hasActiveCover =
                cover &&
                (!!cover.source_url || (!!cover.file_id && cover.sync_status === "COMPLETED"));

            let needsRegeneration = false;
            if (cover && (cover.metadata as any)?.generated) {
                const lastPrimaryId = (cover.metadata as any).primary_file_id;
                if (lastPrimaryId !== primary.file_id) {
                    needsRegeneration = true;
                    console.log(
                        `[VideoCoverService] Primary file ID changed from ${lastPrimaryId} to ${primary.file_id} for media ${mediaId}. Requesting cover regeneration.`,
                    );
                }
            }

            if (hasActiveCover && !needsRegeneration) {
                console.log(
                    `[VideoCoverService] Media ${mediaId} already has a valid cover. Skipping.`,
                );
                return {
                    status: "skipped",
                    mediaId,
                    reason: "cover_already_exists",
                };
            }
        }

        const metadata = {
            generated: true,
            primary_file_id: primary.file_id,
        };

        const now = nowDbTimestamp();

        // 3. Upsert PENDING COVER record to prevent multiple triggers and track status
        if (cover) {
            await db
                .update(MediaFile)
                .set({
                    sync_status: SyncStatus.PENDING,
                    last_error: null,
                    metadata,
                    update_time: now,
                })
                .where(eq(MediaFile.id, cover.id));
        } else {
            await db
                .insert(MediaFile)
                .values({
                    media_id: mediaId,
                    role: MediaFileRole.COVER,
                    sync_status: SyncStatus.PENDING,
                    last_error: null,
                    metadata,
                    create_time: now,
                    update_time: now,
                })
                .onConflictDoUpdate({
                    target: [MediaFile.media_id, MediaFile.role, MediaFile.sort_order],
                    set: {
                        sync_status: SyncStatus.PENDING,
                        last_error: null,
                        metadata,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                        update_time: now,
                    },
                });
        }

        // 4. Trigger QStash workflow
        const client = new Client({ token: env.QSTASH_TOKEN });
        const origin = env.UPSTASH_WORKFLOW_URL || (options?.originUrl ?? "http://localhost:9400");
        const workflowUrl = `${origin.replace(/\/$/, "")}/api/task/workflow-cover`;

        // Use stable workflowRunId to prevent duplicate runs
        const workflowRunId = `video-cover-${mediaId}-${primary.file_id}-${options?.force ? "force" : "auto"}`;
        console.log(
            `[VideoCoverService] Triggering QStash workflow for media ${mediaId} cover generation with run ID ${workflowRunId}.`,
        );

        try {
            await client.trigger({
                url: workflowUrl,
                body: {
                    mediaId,
                    force: options?.force,
                    replaceExternalCover: options?.replaceExternalCover,
                },
                headers: {
                    "Content-Type": "application/json",
                },
                workflowRunId,
            });
        } catch (err: any) {
            console.error(
                `[VideoCoverService] Failed to trigger QStash workflow for media ${mediaId}:`,
                err,
            );
            const failNow = nowDbTimestamp();
            await db
                .update(MediaFile)
                .set({
                    sync_status: SyncStatus.FAILED,
                    last_error: err.message || String(err),
                    update_time: failNow,
                })
                .where(
                    and(eq(MediaFile.media_id, mediaId), eq(MediaFile.role, MediaFileRole.COVER)),
                );
            throw err;
        }

        return {
            status: "queued",
            mediaId,
        };
    },

    /**
     * The actual frame extraction and file-saving worker logic.
     */
    async generateForMedia(
        mediaId: string,
        options?: { force?: boolean; replaceExternalCover?: boolean },
    ): Promise<void> {
        console.log(`[VideoCoverService] Starting cover generation for media ${mediaId}`);
        const mediaResults = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        const media = mediaResults[0];
        if (!media || media.type !== "VIDEO") {
            throw new Error(`Media ${mediaId} is invalid or not a video.`);
        }

        const mediaFiles = await db
            .select()
            .from(MediaFile)
            .where(
                and(
                    eq(MediaFile.media_id, mediaId),
                    eq(MediaFile.delete_status, DeleteStatus.ACTIVE),
                ),
            );
        const primary = mediaFiles.find((mf) => mf.role === "PRIMARY");
        const cover = mediaFiles.find((mf) => mf.role === MediaFileRole.COVER);

        if (!primary || primary.sync_status !== "COMPLETED" || !primary.file_id) {
            throw new Error(
                `Primary file for media ${mediaId} is not completed or missing file_id.`,
            );
        }

        // Set state to IN_PROGRESS
        const progressNow = nowDbTimestamp();
        if (cover) {
            await db
                .update(MediaFile)
                .set({
                    sync_status: SyncStatus.IN_PROGRESS,
                    last_error: null,
                    update_time: progressNow,
                })
                .where(eq(MediaFile.id, cover.id));
        }

        // Final idempotency / bypass check inside the generator worker to handle race conditions
        const coverMetadata = cover?.metadata as any;
        const hasExternalCover = !!cover?.source_url;
        const hasCurrentGeneratedCover =
            !!cover?.file_id &&
            cover.sync_status === "COMPLETED" &&
            coverMetadata?.generated === true &&
            coverMetadata?.primary_file_id === primary.file_id;
        const hasNonGeneratedCover =
            !!cover?.file_id &&
            cover.sync_status === "COMPLETED" &&
            coverMetadata?.generated !== true;

        if (hasExternalCover && options?.replaceExternalCover !== true) {
            console.log(
                `[VideoCoverService] External cover already exists for media ${mediaId} and replaceExternalCover is not set. Skipping.`,
            );
            return;
        }

        if (!options?.force) {
            if (hasCurrentGeneratedCover || hasNonGeneratedCover) {
                console.log(
                    `[VideoCoverService] Valid cover already exists for media ${mediaId}. Skipping cover generation.`,
                );
                return;
            }
        }

        try {
            const physicalFiles = await db
                .select()
                .from(File)
                .where(
                    and(eq(File.id, primary.file_id), eq(File.delete_status, DeleteStatus.ACTIVE)),
                )
                .limit(1);
            const physicalFile = physicalFiles[0];
            if (!physicalFile) {
                throw new Error(`Physical file record ${primary.file_id} not found in database.`);
            }

            let coverBytes: Uint8Array;

            try {
                // Generate a secure, temporary S3 pre-signed URL for direct streaming by FFmpeg
                console.log(
                    `[VideoCoverService] Generating secure pre-signed URL for S3 key: ${physicalFile.path}`,
                );
                const presignedUrl = await s3.getPresignedUrl(physicalFile.path, {
                    bucket: physicalFile.bucket,
                    expiresInSeconds: 900, // 15 mins
                });

                console.log(`[VideoCoverService] Extracting video frame from S3 pre-signed URL.`);
                coverBytes = await extractVideoFrame(presignedUrl);
            } catch (s3Err: any) {
                console.warn(
                    `[VideoCoverService] Failed extraction from S3 pre-signed URL: ${s3Err.message}. Trying CDN URL as fallback...`,
                );

                const cdnUrl = buildCdnUrl(physicalFile.bucket, physicalFile.path);
                try {
                    if (!cdnUrl) {
                        throw new Error("CDN URL could not be constructed.");
                    }
                    console.log(
                        `[VideoCoverService] Extracting video frame from CDN URL: ${cdnUrl}`,
                    );
                    coverBytes = await extractVideoFrame(cdnUrl);
                } catch (cdnErr: any) {
                    console.warn(
                        `[VideoCoverService] Failed extraction from CDN URL: ${cdnErr.message}. Retrying extraction from primary source URL as final fallback.`,
                    );
                    if (primary.source_url) {
                        coverBytes = await extractVideoFrame(primary.source_url);
                    } else {
                        throw cdnErr;
                    }
                }
            }

            // Upload to S3
            const ownerId = media.post_id ?? media.id;
            const coverFilePath = media.post_id
                ? `v2/p/${ownerId.slice(-2)}/${ownerId}/${media.sort_order}_cover.avif`
                : `v2/m/${media.id.slice(-2)}/${media.id}/cover.avif`;
            const contentType = "image/avif";
            const ext = "avif";

            console.log(`[VideoCoverService] Uploading cover frame to S3 key: ${coverFilePath}`);
            await uploadToS3(
                coverFilePath,
                coverBytes,
                contentType,
                env.S3_BUCKET,
                coverBytes.length,
            );

            // Save File
            const coverFileResults = await db
                .insert(File)
                .values({
                    path: coverFilePath,
                    mime_type: contentType,
                    extension: ext,
                    bucket: env.S3_BUCKET,
                })
                .onConflictDoUpdate({
                    target: File.path,
                    set: {
                        mime_type: contentType,
                        extension: ext,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                    },
                })
                .returning({ id: File.id });

            const coverFileId = coverFileResults[0].id;

            // Save MediaFile
            const metadata = {
                generated: true,
                primary_file_id: primary.file_id,
                seek_seconds: 1,
            };

            const completedNow = nowDbTimestamp();
            if (cover) {
                await db
                    .update(MediaFile)
                    .set({
                        file_id: coverFileId,
                        sync_status: SyncStatus.COMPLETED,
                        last_error: null,
                        metadata,
                        update_time: completedNow,
                    })
                    .where(eq(MediaFile.id, cover.id));
            } else {
                await db
                    .insert(MediaFile)
                    .values({
                        media_id: media.id,
                        role: MediaFileRole.COVER,
                        file_id: coverFileId,
                        sync_status: SyncStatus.COMPLETED,
                        last_error: null,
                        metadata,
                        create_time: completedNow,
                        update_time: completedNow,
                    })
                    .onConflictDoUpdate({
                        target: [MediaFile.media_id, MediaFile.role, MediaFile.sort_order],
                        set: {
                            file_id: coverFileId,
                            sync_status: SyncStatus.COMPLETED,
                            last_error: null,
                            metadata,
                            delete_status: DeleteStatus.ACTIVE,
                            delete_time: null,
                            update_time: completedNow,
                        },
                    });
            }

            console.log(
                `[VideoCoverService] Generated cover successfully completed for media ${mediaId}.`,
            );
        } catch (err: any) {
            const errorMsg = err.message || String(err);
            console.error(
                `[VideoCoverService] Error during cover generation for media ${mediaId}: ${errorMsg}`,
            );
            const failNow = nowDbTimestamp();
            await db
                .update(MediaFile)
                .set({
                    sync_status: SyncStatus.FAILED,
                    last_error: errorMsg,
                    update_time: failNow,
                })
                .where(
                    and(eq(MediaFile.media_id, mediaId), eq(MediaFile.role, MediaFileRole.COVER)),
                );
            throw err;
        }
    },

    /**
     * Scan the database for videos that are missing covers (either no cover record, failed cover,
     * or stuck pending/in-progress cover) and trigger cover generation for them.
     */
    async scanAndQueueMissingCovers(
        options: ScanMissingCoversOptions,
    ): Promise<ScanMissingCoversResult> {
        const libraryId = options.libraryId;
        const limit = Math.min(options.limit ?? 100, 500);
        const staleMinutes = options.staleMinutes ?? 15;
        const originUrl = options.originUrl;

        const lockKey = libraryId
            ? `lock:video-cover-scan:library:${libraryId}`
            : `lock:video-cover-scan:global`;

        try {
            return await withLock(
                lockKey,
                async () => {
                    const primaryMediaFile = alias(MediaFile, "primary_media_file");
                    const coverMediaFile = alias(MediaFile, "cover_media_file");

                    const staleThreshold = Temporal.Now.instant().subtract({
                        minutes: staleMinutes,
                    });

                    // Query criteria
                    const whereConditions = [
                        eq(Media.type, MediaType.VIDEO),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        isNull(Media.recycle_time),
                        eq(primaryMediaFile.role, MediaFileRole.PRIMARY),
                        eq(primaryMediaFile.sync_status, SyncStatus.COMPLETED),
                        eq(primaryMediaFile.delete_status, DeleteStatus.ACTIVE),
                    ];

                    if (libraryId) {
                        whereConditions.push(eq(Media.library_id, libraryId));
                    }

                    // Query one more row than limit to check hasMore
                    const queryLimit = limit + 1;

                    const results = await db
                        .select({
                            mediaId: Media.id,
                            primaryFileId: primaryMediaFile.file_id,
                            coverId: coverMediaFile.id,
                            coverFileId: coverMediaFile.file_id,
                            coverSourceUrl: coverMediaFile.source_url,
                            coverSyncStatus: coverMediaFile.sync_status,
                            coverUpdateTime: coverMediaFile.update_time,
                            coverMetadata: coverMediaFile.metadata,
                        })
                        .from(Media)
                        .innerJoin(primaryMediaFile, and(eq(Media.id, primaryMediaFile.media_id)))
                        .leftJoin(
                            coverMediaFile,
                            and(
                                eq(Media.id, coverMediaFile.media_id),
                                eq(coverMediaFile.role, MediaFileRole.COVER),
                                eq(coverMediaFile.delete_status, DeleteStatus.ACTIVE),
                            ),
                        )
                        .where(and(...whereConditions));

                    let scanned = 0;
                    let matched = 0;
                    let queued = 0;
                    let skipped = 0;
                    let alreadyPending = 0;
                    let failed = 0;
                    const failures: Array<{ mediaId: string; error: string }> = [];

                    const candidates: string[] = [];

                    for (const row of results) {
                        scanned++;
                        const {
                            mediaId,
                            primaryFileId,
                            coverId,
                            coverFileId,
                            coverSourceUrl,
                            coverSyncStatus,
                            coverUpdateTime,
                            coverMetadata,
                        } = row;

                        if (!primaryFileId) {
                            continue;
                        }

                        // Skip if it is an external cover (source_url exists)
                        if (coverSourceUrl && coverSourceUrl.trim() !== "") {
                            continue;
                        }

                        let isMatched = false;

                        if (!coverId) {
                            // 1. No COVER row exists
                            isMatched = true;
                        } else if (
                            !coverFileId &&
                            (!coverSourceUrl || coverSourceUrl.trim() === "")
                        ) {
                            // 2. COVER.file_id IS NULL and COVER.source_url is empty
                            isMatched = true;
                        } else if (coverSyncStatus === SyncStatus.FAILED) {
                            // 3. COVER.sync_status = FAILED
                            isMatched = true;
                        } else if (
                            (coverSyncStatus === SyncStatus.PENDING ||
                                coverSyncStatus === SyncStatus.IN_PROGRESS) &&
                            coverUpdateTime &&
                            Temporal.Instant.compare(coverUpdateTime, staleThreshold) < 0
                        ) {
                            // 4. COVER.sync_status IN (PENDING, IN_PROGRESS) and update_time older than staleMinutes
                            isMatched = true;
                        } else {
                            // 5. COVER.metadata.generated = true and COVER.metadata.primary_file_id != PRIMARY.file_id
                            const metadata = coverMetadata as any;
                            if (
                                metadata &&
                                metadata.generated === true &&
                                metadata.primary_file_id !== primaryFileId
                            ) {
                                isMatched = true;
                            }
                        }

                        if (isMatched) {
                            matched++;
                            if (candidates.length < queryLimit) {
                                candidates.push(mediaId);
                            }
                        }
                    }

                    const hasMore = candidates.length > limit;
                    const toQueue = candidates.slice(0, limit);

                    for (const mediaId of toQueue) {
                        try {
                            const res = await this.requestForMedia(mediaId, {
                                originUrl,
                                force: false,
                                replaceExternalCover: false,
                            });
                            if (res.status === "queued") {
                                queued++;
                            } else if (res.status === "skipped") {
                                skipped++;
                            } else if (res.status === "already_pending") {
                                alreadyPending++;
                            }
                        } catch (err: any) {
                            failed++;
                            failures.push({
                                mediaId,
                                error: err.message || String(err),
                            });
                        }
                    }

                    return {
                        scanned,
                        matched,
                        queued,
                        skipped,
                        alreadyPending,
                        failed,
                        hasMore,
                        failures,
                    };
                },
                { ttl: 600 },
            );
        } catch (err: any) {
            if (err?.message === "LOCKED_CONCURRENT_EXECUTION") {
                console.log(
                    `[VideoCoverService] Scan lock is already held. Returning locked: true.`,
                );
                return {
                    scanned: 0,
                    matched: 0,
                    queued: 0,
                    skipped: 0,
                    alreadyPending: 0,
                    failed: 0,
                    hasMore: false,
                    failures: [],
                    locked: true,
                };
            }
            throw err;
        }
    },
};
