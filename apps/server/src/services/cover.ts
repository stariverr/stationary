import { db } from "@/global/db";
import {
    Media,
    Track,
    File as DbFile,
    DeleteStatus,
    SyncStatus,
    TrackType,
    TrackPurpose,
    MediaType,
    type GeneratedCoverMetadata,
} from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { renderCoverFrame } from "@/lib/utils/cover_renderer";
import { RECIPE_VERSION } from "@/lib/utils/cover_profiles";
import { uploadToS3 } from "@/lib/utils/media";
import { s3 } from "@/global/s3";
import { env } from "@/global/env";
import { Quality } from "@/lib/types";
import { DeleteService } from "@/services/delete";
import { Temporal } from "@js-temporal/polyfill";

export interface ResolvedCoverSource {
    track: typeof Track.$inferSelect;
    fileId: string;
    filePath: string;
    fileBucket: string;
}

export interface GenerateCoverParams {
    media: typeof Media.$inferSelect;
    quality: Quality;
    source: ResolvedCoverSource;
    sourceTrackId?: string;
    sourceFileId?: string;
}

export interface GenerateCoverResult {
    success: boolean;
    skipped?: boolean;
    outcomeCode: string;
    fileId?: string;
    error?: string;
    retryable?: boolean;
}

export const UNSUPPORTED_COVER_EXTENSIONS = new Set(["vvic", "jxl"]);

export function rankCoverCandidateTrack<T extends { track: typeof Track.$inferSelect; file: typeof DbFile.$inferSelect }>(
    a: T,
    b: T,
): number {
    const extA = (a.file.extension || "").toLowerCase();
    const extB = (b.file.extension || "").toLowerCase();
    const isSupportedA = !UNSUPPORTED_COVER_EXTENSIONS.has(extA);
    const isSupportedB = !UNSUPPORTED_COVER_EXTENSIONS.has(extB);

    if (isSupportedA !== isSupportedB) {
        return isSupportedA ? -1 : 1;
    }

    const typeOrder: Record<string, number> = {
        [TrackType.IMAGE]: 1,
        [TrackType.VIDEO]: 2,
    };
    const orderA = typeOrder[a.track.type] ?? 99;
    const orderB = typeOrder[b.track.type] ?? 99;
    if (orderA !== orderB) {
        return orderA - orderB;
    }

    const primaryA = a.track.is_primary ? 1 : 0;
    const primaryB = b.track.is_primary ? 1 : 0;
    if (primaryA !== primaryB) {
        return primaryB - primaryA;
    }

    const defaultA = a.track.is_default ? 1 : 0;
    const defaultB = b.track.is_default ? 1 : 0;
    if (defaultA !== defaultB) {
        return defaultB - defaultA;
    }

    const prioA = a.track.priority ?? 0;
    const prioB = b.track.priority ?? 0;
    if (prioA !== prioB) {
        return prioA - prioB;
    }

    return 0;
}

export const CoverService = {
    /**
     * Resolve valid source track & file for cover generation.
     * Priority:
     * 1. Purpose must be CONTENT and delete_status ACTIVE
     * 2. Supported / renderable media extensions (prefer standard formats over vvic/jxl)
     * 3. TrackType priority: IMAGE -> VIDEO
     * 4. is_primary (true before false)
     * 5. is_default (true before false)
     * 6. priority score (lower priority number first)
     */
    async resolveSourceTrack(media: typeof Media.$inferSelect): Promise<ResolvedCoverSource | null> {
        const rows = await db
            .select({
                track: Track,
                file: DbFile,
            })
            .from(Track)
            .innerJoin(DbFile, eq(Track.file_id, DbFile.id))
            .where(
                and(
                    eq(Track.media_id, media.id),
                    eq(Track.purpose, TrackPurpose.CONTENT),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(DbFile.delete_status, DeleteStatus.ACTIVE),
                ),
            );

        if (!rows.length) {
            return null;
        }

        rows.sort(rankCoverCandidateTrack);

        const candidate = rows[0]!;
        return {
            track: candidate.track,
            fileId: candidate.file.id,
            filePath: candidate.file.path,
            fileBucket: candidate.file.bucket,
        };
    },

    /**
     * Generate, render, and persist cover image for a media item.
     * 1. Presign internal S3 source file URL
     * 2. Render target frame with FFmpeg
     * 3. Upload generated AVIF to S3
     * 4. Upsert DbFile & Track records in database
     * 5. Clean up superseded old cover files safely
     */
    async generateCover(params: GenerateCoverParams): Promise<GenerateCoverResult> {
        const { media, quality, source } = params;

        // Strictly use internal S3 file for rendering
        const sourceUrlForFFmpeg = await s3.getPresignedUrl(source.filePath, {
            bucket: source.fileBucket,
            expiresInSeconds: 900,
        });

        const renderMediaType = source.track.type === TrackType.VIDEO ? MediaType.VIDEO : MediaType.IMAGE;

        let renderResult;
        try {
            renderResult = await renderCoverFrame(sourceUrlForFFmpeg, renderMediaType, quality);
        } catch (err: any) {
            const errorMsg = String(err?.message || err);
            console.error(`[CoverService] Cover render failed for media ${media.id}:`, errorMsg);
            return {
                success: false,
                retryable: false,
                outcomeCode: "RENDER_FAILED",
                error: errorMsg,
            };
        }

        const shard = media.id.slice(-2);
        const qualityLower = quality.toLowerCase();
        const sourceFileId = params.sourceFileId || source.fileId;
        const s3Key = media.post_id
            ? `v2/p/${media.post_id.slice(-2)}/${media.post_id}/${media.sort_order}_cover/${qualityLower}/v${RECIPE_VERSION}-${sourceFileId}.avif`
            : `v2/m/${shard}/${media.id}/cover/${qualityLower}/v${RECIPE_VERSION}-${sourceFileId}.avif`;

        await uploadToS3(s3Key, renderResult.buffer, "image/avif", env.S3_BUCKET, renderResult.size);

        const fileResults = await db
            .insert(DbFile)
            .values({
                path: s3Key,
                mime_type: "image/avif",
                extension: "avif",
                bucket: env.S3_BUCKET,
                size: renderResult.size,
                width: renderResult.width,
                height: renderResult.height,
            })
            .onConflictDoUpdate({
                target: DbFile.path,
                set: {
                    mime_type: "image/avif",
                    extension: "avif",
                    size: renderResult.size,
                    width: renderResult.width,
                    height: renderResult.height,
                    delete_status: DeleteStatus.ACTIVE,
                    delete_time: null,
                },
            })
            .returning({ id: DbFile.id });

        const newFileId = fileResults[0]!.id;
        const variantKey = `cover:${qualityLower}:recipe:${RECIPE_VERSION}`;
        const metadata: GeneratedCoverMetadata = {
            source_track_id: params.sourceTrackId || source.track.id,
            source_file_id: sourceFileId,
            recipe_version: RECIPE_VERSION,
            generation_mode: source.track.type === TrackType.VIDEO ? "VIDEO_FRAME" : "TRANSCODE",
            generated_width: renderResult.width,
            generated_height: renderResult.height,
        };

        const existingTracks = await db
            .select()
            .from(Track)
            .where(and(eq(Track.media_id, media.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));
        const existingCoverTrack = existingTracks.find((t) => t.purpose === TrackPurpose.COVER && t.variant_key === variantKey);

        const completedNow = Temporal.Now.instant();
        let oldFileIdToDelete: string | null = null;

        if (existingCoverTrack) {
            if (existingCoverTrack.file_id && existingCoverTrack.file_id !== newFileId) {
                oldFileIdToDelete = existingCoverTrack.file_id;
            }
            await db
                .update(Track)
                .set({
                    file_id: newFileId,
                    sync_status: SyncStatus.COMPLETED,
                    last_error: null,
                    metadata,
                    is_generated: true,
                    is_original: false,
                    source_track_id: source.track.id,
                    update_time: completedNow,
                })
                .where(eq(Track.id, existingCoverTrack.id));
        } else {
            await db.insert(Track).values({
                media_id: media.id,
                type: TrackType.IMAGE,
                purpose: TrackPurpose.COVER,
                quality: quality as any,
                priority: quality === Quality.LOW ? 10 : quality === Quality.MEDIUM ? 20 : 30,
                file_id: newFileId,
                sync_status: SyncStatus.COMPLETED,
                last_error: null,
                metadata,
                variant_key: variantKey,
                is_generated: true,
                is_original: false,
                source_track_id: source.track.id,
                create_time: completedNow,
                update_time: completedNow,
            });
        }

        if (oldFileIdToDelete) {
            const canPurge = await DeleteService.canPurgeFile(oldFileIdToDelete);
            if (canPurge) {
                await db
                    .update(DbFile)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: completedNow })
                    .where(eq(DbFile.id, oldFileIdToDelete));
            }
        }

        return { success: true, outcomeCode: "SUCCESS", fileId: newFileId };
    },
};
