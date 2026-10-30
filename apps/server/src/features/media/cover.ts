import { db, type Transaction } from "@/global/db";
import {
    Media,
    Track,
    File as DbFile,
    DeleteStatus,
    SyncStatus,
    TrackType,
    TrackPurpose,
    MediaType,
    type TrackMetadata,
} from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { renderCoverFrame } from "@/lib/utils/cover_renderer";
import { RECIPE_VERSION } from "@/lib/utils/cover_profiles";
import { uploadToS3 } from "@/lib/utils/media";
import { s3 } from "@/global/s3";
import { env } from "@/global/env";
import { Quality } from "@/lib/types";

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
    signal?: AbortSignal;
    /** Runs first in the transaction that stores the cover (the queue's fence goes here). */
    beforePersist?: (tx: Transaction) => Promise<void>;
}

export const coverVariantKey = (quality: Quality) => `cover:${quality.toLowerCase()}:recipe:${RECIPE_VERSION}`;

export const coverPriority = (quality: Quality) => (quality === Quality.LOW ? 10 : quality === Quality.MEDIUM ? 20 : 30);

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

/**
 * Picks the content track a cover is rendered from, among completed CONTENT tracks with an active file:
 * renderable formats first (vvic/jxl last), then IMAGE before VIDEO, primary, default, and lower priority.
 */
export function pickCoverSource(
    rows: { track: typeof Track.$inferSelect; file: typeof DbFile.$inferSelect | null }[],
): ResolvedCoverSource | null {
    const candidates = rows.flatMap(({ track, file }) =>
        track.purpose === TrackPurpose.CONTENT &&
        track.delete_status === DeleteStatus.ACTIVE &&
        track.sync_status === SyncStatus.COMPLETED &&
        file?.delete_status === DeleteStatus.ACTIVE &&
        track.file_id === file.id
            ? [{ track, file }]
            : [],
    );
    if (candidates.length === 0) return null;
    candidates.sort(rankCoverCandidateTrack);
    const best = candidates[0]!;
    return { track: best.track, fileId: best.file.id, filePath: best.file.path, fileBucket: best.file.bucket };
}

export const CoverService = {
    /**
     * Renders one cover quality from `source`, uploads it, and points the quality's cover track at it. Superseded
     * cover files are marked deleted; cover tracks of other qualities are left alone.
     *
     * Returns false without storing anything when the media was recycled or deleted, or the source track no longer
     * holds the source file, meanwhile. Throws UndecodableSourceError when the source cannot be decoded.
     */
    async generateCover({ media, quality, source, signal, beforePersist }: GenerateCoverParams): Promise<boolean> {
        const sourceUrlForFFmpeg = await s3.getPresignedUrl(source.filePath, {
            bucket: source.fileBucket,
            expiresInSeconds: 900,
        });

        const renderMediaType = source.track.type === TrackType.VIDEO ? MediaType.VIDEO : MediaType.IMAGE;

        const renderResult = await renderCoverFrame(sourceUrlForFFmpeg, renderMediaType, quality);
        signal?.throwIfAborted();

        const qualityLower = quality.toLowerCase();
        const sourceFileId = source.fileId;
        const sourceTrackId = source.track.id;
        const s3Key = media.post_id
            ? `v2/p/${media.post_id.slice(-2)}/${media.post_id}/media_${media.id}/cover/${qualityLower}/v${RECIPE_VERSION}-${sourceFileId}.avif`
            : `v2/m/${media.id.slice(-2)}/${media.id}/cover/${qualityLower}/v${RECIPE_VERSION}-${sourceFileId}.avif`;

        await uploadToS3(s3Key, renderResult.buffer, "image/avif", env.S3_BUCKET, renderResult.size, signal);
        signal?.throwIfAborted();

        return db.transaction(async (tx) => {
            await beforePersist?.(tx);
            const [activeMedia] = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.id, media.id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
                .limit(1);
            if (!activeMedia) return false;

            const [activeSourceTrack] = await tx
                .select({ id: Track.id })
                .from(Track)
                .where(
                    and(
                        eq(Track.id, sourceTrackId),
                        eq(Track.media_id, media.id),
                        eq(Track.file_id, sourceFileId),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                        eq(Track.sync_status, SyncStatus.COMPLETED),
                    ),
                )
                .limit(1);
            if (!activeSourceTrack) return false;

            const [file] = await tx
                .insert(DbFile)
                .values({
                    path: s3Key,
                    mime_type: "image/avif",
                    extension: "avif",
                    bucket: env.S3_BUCKET,
                    size: renderResult.size,
                })
                .onConflictDoUpdate({
                    target: DbFile.path,
                    set: {
                        mime_type: "image/avif",
                        extension: "avif",
                        size: renderResult.size,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                    },
                })
                .returning({ id: DbFile.id });

            const createdFileId = file!.id;
            const variantKey = coverVariantKey(quality);
            const metadata: TrackMetadata = {
                source_file_id: sourceFileId,
                recipe_version: RECIPE_VERSION,
                generation_mode: source.track.type === TrackType.VIDEO ? "VIDEO_FRAME" : "TRANSCODE",
                generated_width: renderResult.width,
                generated_height: renderResult.height,
            };
            const now = Temporal.Now.instant();
            const coverFields = {
                file_id: createdFileId,
                sync_status: SyncStatus.COMPLETED,
                last_error: null,
                metadata,
                width: renderResult.width,
                height: renderResult.height,
                is_generated: true,
                is_original: false,
                is_stale: false,
                source_track_id: sourceTrackId,
                update_time: now,
            };

            const [existing] = await tx
                .select({ id: Track.id, file_id: Track.file_id })
                .from(Track)
                .where(
                    and(
                        eq(Track.media_id, media.id),
                        eq(Track.type, TrackType.IMAGE),
                        eq(Track.purpose, TrackPurpose.COVER),
                        eq(Track.variant_key, variantKey),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                    ),
                )
                .for("update");

            if (existing) {
                await tx.update(Track).set(coverFields).where(eq(Track.id, existing.id));
                if (existing.file_id && existing.file_id !== createdFileId) {
                    await tx
                        .update(DbFile)
                        .set({ delete_status: DeleteStatus.DELETED, delete_time: now })
                        .where(and(eq(DbFile.id, existing.file_id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));
                }
            } else {
                await tx.insert(Track).values({
                    ...coverFields,
                    media_id: media.id,
                    type: TrackType.IMAGE,
                    purpose: TrackPurpose.COVER,
                    quality,
                    priority: coverPriority(quality),
                    variant_key: variantKey,
                    create_time: now,
                });
            }
            return true;
        });
    },
};
