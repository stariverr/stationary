import { db } from "@/global/db";
import { Media, Track, File as DbFile, DeleteStatus, SyncStatus, TrackPurpose, TrackType, type MediaFileMetadata } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";
import { Quality } from "@/lib/types";

export interface MappedFileRow {
    track_id: string;
    media_id: string | null;
    type: TrackType;
    purpose: TrackPurpose;
    is_original: boolean;
    quality: Quality;
    priority: number;
    metadata: MediaFileMetadata;
    variant_key: string;
    is_default: boolean;
    is_primary: boolean;
    display_name: string | null;
    language: string | null;
    codec: string | null;
    is_stale: boolean;
    file_id: string | null;
    file_path: string | null;
    file_bucket: string | null;
    mime_type: string | null;
    extension: string | null;
    width: number | null;
    height: number | null;
}

export interface PreviewItem {
    url: string | null;
    quality: Quality;
    codec: string | null;
}

const buildUrl = (bucket: string | null | undefined, path: string | null | undefined) =>
    bucket && path ? buildCdnUrl(bucket, path) : null;

/**
 * Batch-fetches ONLY `COVER` tracks for given media IDs in list queries.
 */
export async function getMediaCoversMap(mediaIds: string[]): Promise<Map<string, PreviewItem[]>> {
    const map = new Map<string, PreviewItem[]>();
    if (!mediaIds.length) return map;

    const rows = await db
        .select()
        .from(Track)
        .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
        .where(
            and(
                inArray(Track.media_id, mediaIds),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
                eq(Track.sync_status, SyncStatus.COMPLETED),
                eq(Track.purpose, TrackPurpose.COVER),
            ),
        );

    for (const { track, file } of rows) {
        if (!track.media_id) continue;
        const list = map.get(track.media_id) || [];
        list.push({
            url: buildUrl(file?.bucket, file?.path),
            quality: track.quality,
            codec: track.codec,
        });
        // Sort list by LOW -> MEDIUM -> HIGH
        const qualityOrder: Record<Quality, number> = {
            [Quality.LOW]: 1,
            [Quality.MEDIUM]: 2,
            [Quality.HIGH]: 3,
        };
        list.sort((a, b) => (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99));
        map.set(track.media_id, list);
    }
    return map;
}

/**
 * Batch-fetches CONTENT VIDEO tracks for given media IDs in list queries.
 */
export async function getMediaVideosMap(mediaIds: string[]): Promise<Map<string, PreviewItem[]>> {
    const map = new Map<string, PreviewItem[]>();
    if (!mediaIds.length) return map;

    const rows = await db
        .select()
        .from(Track)
        .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
        .where(
            and(
                inArray(Track.media_id, mediaIds),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
                eq(Track.sync_status, SyncStatus.COMPLETED),
                eq(Track.type, TrackType.VIDEO),
                eq(Track.purpose, TrackPurpose.CONTENT),
            ),
        );

    for (const { track, file } of rows) {
        if (!track.media_id) continue;
        const list = map.get(track.media_id) || [];
        list.push({
            url: buildUrl(file?.bucket, file?.path),
            quality: track.quality,
            codec: track.codec,
        });
        map.set(track.media_id, list);
    }
    return map;
}

/**
 * Fetches all active & completed tracks for a single media item in detail mode.
 */
export async function getMediaTracks(mediaId: string): Promise<MappedFileRow[]> {
    const rows = await db
        .select()
        .from(Track)
        .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
        .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE), eq(Track.sync_status, SyncStatus.COMPLETED)));

    return rows.map(({ track, file }) => ({
        track_id: track.id,
        media_id: track.media_id,
        type: track.type,
        purpose: track.purpose,
        is_original: track.is_original,
        quality: track.quality,
        priority: track.priority,
        metadata: track.metadata || {},
        variant_key: track.variant_key,
        is_default: track.is_default,
        is_primary: track.is_primary,
        display_name: track.display_name,
        language: track.language,
        codec: track.codec,
        is_stale: track.is_stale,
        file_id: file?.id || null,
        file_path: file?.path || null,
        file_bucket: file?.bucket || null,
        mime_type: file?.mime_type || null,
        extension: file?.extension || null,
        width: file?.width || null,
        height: file?.height || null,
    }));
}

/**
 * Formats a Media record and its detailed tracks into a full API response object.
 */
export function formatMediaDetail(media: typeof Media.$inferSelect, files: MappedFileRow[]) {
    const sorted = [...files].sort((a, b) => a.priority - b.priority);

    const coverFiles = sorted.filter((f) => f.purpose === TrackPurpose.COVER);

    // Pick cover file by priority: LOW -> MEDIUM -> HIGH -> any COVER
    const qualityOrder: Record<string, number> = {
        [Quality.LOW]: 1,
        [Quality.MEDIUM]: 2,
        [Quality.HIGH]: 3,
    };
    const sortedCoverFiles = [...coverFiles].sort((a, b) => (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99));

    const coverFile = sortedCoverFiles[0];
    const primaryFile = sorted.find((f) => f.is_primary) || sorted.find((f) => f.purpose === TrackPurpose.CONTENT);

    const url = media.type === "VIDEO" ? `/api/media/${media.id}/manifest.mpd` : buildUrl(primaryFile?.file_bucket, primaryFile?.file_path);

    const coverVariants: Record<string, any> = {};
    for (const f of coverFiles) {
        if (f.file_bucket && f.file_path && (f.quality === Quality.LOW || f.quality === Quality.MEDIUM || f.quality === Quality.HIGH)) {
            coverVariants[f.quality] = {
                track_id: f.track_id,
                url: buildUrl(f.file_bucket, f.file_path),
                width: f.width,
                height: f.height,
                status: f.is_stale ? "STALE" : "READY",
            };
        }
    }

    const externalCover = coverFiles.find((f) => !f.is_original);
    const coverSource = externalCover
        ? {
              track_id: externalCover.track_id,
              url: buildUrl(externalCover.file_bucket, externalCover.file_path),
              quality: externalCover.quality,
          }
        : null;

    const tracks = sorted
        .filter((f) => f.file_path && f.file_bucket)
        .map((f) => ({
            id: f.track_id,
            file_id: f.file_id || "",
            url: buildUrl(f.file_bucket, f.file_path) || "",
            type: f.type,
            purpose: f.purpose,
            is_original: f.is_original,
            quality: f.quality,
            priority: f.priority,
            metadata: f.metadata || {},
            variant_key: f.variant_key,
            is_default: f.is_default,
            is_primary: f.is_primary,
            display_name: f.display_name,
            language: f.language,
            codec: f.codec,
            is_stale: f.is_stale,
        }));

    return {
        id: media.id,
        eid: media.eid,
        post_id: media.post_id ?? null,
        source: media.source,
        title: media.title,
        description: media.description,
        type: media.type,
        sort_order: media.sort_order,
        create_time: toIsoTimestamp(media.create_time) ?? undefined,
        published_time: toIsoTimestamp(media.published_time) ?? undefined,
        sync_status: media.sync_status,
        last_error: media.last_error,
        url,
        cover_url: buildUrl(coverFile?.file_bucket, coverFile?.file_path),
        cover_source: coverSource,
        cover_variants: coverVariants,
        width: primaryFile?.width ?? null,
        height: primaryFile?.height ?? null,
        tracks,
    };
}
