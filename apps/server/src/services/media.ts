import { and, asc, eq, inArray, or } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import {
    Media,
    MediaTag,
    Track,
    File as DbFile,
    DeleteStatus,
    SyncStatus,
    TrackPurpose,
    TrackType,
    Post,
    type TrackMetadata,
} from "@/db/schema";
import { Temporal } from "@js-temporal/polyfill";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";
import { Quality } from "@/lib/types";
import { resolveMediaPlayback, type PlaybackTrackInput } from "@/lib/utils/media-playback";
import {
    buildDashManifest,
    type DashVideoRepresentation,
    type DashAudioRepresentation,
    type DashSegmentBase,
} from "@/lib/utils/dash-manifest";
import { isDashCompatibleFormat } from "@/lib/utils/track-format";

export interface PreviewItem {
    url: string | null;
    quality: Quality;
    codec: string | null;
}

const buildUrl = (bucket: string | null | undefined, path: string | null | undefined) =>
    bucket && path ? buildCdnUrl(bucket, path) : null;

export async function replaceMediaTagsTx(tx: Transaction, mediaId: string, libraryId: string, tagIds: string[]) {
    const existing = await tx.select({ tag_id: MediaTag.tag_id }).from(MediaTag).where(eq(MediaTag.media_id, mediaId));
    const existingIds = new Set(existing.map((r) => r.tag_id));
    const newIds = new Set(tagIds);

    const toDelete = Array.from(existingIds).filter((id) => !newIds.has(id));
    const toInsert = Array.from(newIds).filter((id) => !existingIds.has(id));

    if (toDelete.length > 0) {
        await tx.delete(MediaTag).where(and(eq(MediaTag.media_id, mediaId), inArray(MediaTag.tag_id, toDelete)));
    }
    if (toInsert.length > 0) {
        await tx.insert(MediaTag).values(
            toInsert.map((tagId) => ({
                media_id: mediaId,
                tag_id: tagId,
            })),
        );
    }
}

export const MediaService = {
    async updateInfo(
        id: string,
        fields: {
            title?: string;
            description?: string;
            published_time?: Temporal.Instant | null;
        },
    ) {
        const updateFields: any = {
            update_time: Temporal.Now.instant(),
        };
        if (fields.title !== undefined) updateFields.title = fields.title;
        if (fields.description !== undefined) updateFields.description = fields.description;
        if (fields.published_time !== undefined) updateFields.published_time = fields.published_time;

        const updated = await db.update(Media).set(updateFields).where(eq(Media.id, id)).returning();
        return updated[0];
    },

    async replaceTags(id: string, libraryId: string, tagIds: string[]) {
        return db.transaction(async (tx) => {
            await replaceMediaTagsTx(tx, id, libraryId, tagIds);
            return tagIds;
        });
    },

    async syncMediaAndPostStatus(mediaId: string, tx: Transaction, now = Temporal.Now.instant()) {
        await tx
            .update(Media)
            .set({
                sync_status: SyncStatus.COMPLETED,
                update_time: now,
            })
            .where(eq(Media.id, mediaId));

        const [media] = await tx.select({ post_id: Media.post_id }).from(Media).where(eq(Media.id, mediaId)).limit(1);
        if (media?.post_id) {
            const activeMedias = await tx
                .select({ sync_status: Media.sync_status })
                .from(Media)
                .where(and(eq(Media.post_id, media.post_id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            const allCompleted = activeMedias.every((m) => m.sync_status === SyncStatus.COMPLETED);
            if (allCompleted) {
                await tx
                    .update(Post)
                    .set({
                        sync_status: SyncStatus.COMPLETED,
                        update_time: now,
                    })
                    .where(eq(Post.id, media.post_id));
            }
        }
    },

    /**
     * Single-pass batch fetch & DTO hydration for Media Details.
     * Performs a single SQL query pass for multiple media items and returns full playback, tracks, and covers.
     */
    async getDetails(mediaList: Array<typeof Media.$inferSelect>, startPosition = 0) {
        if (!mediaList.length) return [];
        const mediaIds = mediaList.map((m) => m.id);

        const rows = await db
            .select({
                track: Track,
                file: DbFile,
            })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    inArray(Track.media_id, mediaIds),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                ),
            );

        const tracksByMedia = new Map<string, Array<{ track: typeof Track.$inferSelect; file: typeof DbFile.$inferSelect | null }>>();
        for (const row of rows) {
            if (!row.track.media_id) continue;
            const list = tracksByMedia.get(row.track.media_id) || [];
            list.push(row);
            tracksByMedia.set(row.track.media_id, list);
        }

        return mediaList.map((media, index) => {
            const rawRows = tracksByMedia.get(media.id) || [];
            const sorted = [...rawRows].sort((a, b) => a.track.priority - b.track.priority);
            const coverRows = sorted.filter((r) => r.track.purpose === TrackPurpose.COVER);

            const covers: PreviewItem[] = coverRows.map(({ track, file }) => ({
                url: buildUrl(file?.bucket, file?.path),
                quality: track.quality,
                codec: track.codec,
            }));

            const primaryRow = sorted.find((r) => r.track.is_primary) || sorted.find((r) => r.track.purpose === TrackPurpose.CONTENT);

            // Single-pass direct mapping to playback inputs
            const playbackInputs: PlaybackTrackInput[] = sorted.map(({ track, file }) => ({
                track_id: track.id,
                type: track.type,
                purpose: track.purpose,
                priority: track.priority,
                quality: track.quality,
                is_default: track.is_default,
                is_primary: track.is_primary,
                display_name: track.display_name,
                language: track.language,
                codec: track.codec,
                metadata: track.metadata,
                container: track.container,
                is_fragmented: track.is_fragmented,
                stream_layout: track.stream_layout,
                has_video: track.has_video,
                has_audio: track.has_audio,
                streams: track.streams,
                width: track.width,
                height: track.height,
                bandwidth: track.bandwidth || null,
                url: buildUrl(file?.bucket, file?.path),
                mime_type: file?.mime_type || null,
            }));

            const playback = media.type === "VIDEO" ? resolveMediaPlayback(media.id, playbackInputs) : null;
            const mainUrl = media.type === "VIDEO" ? playback?.url || null : buildUrl(primaryRow?.file?.bucket, primaryRow?.file?.path);

            const tracks = sorted
                .filter((r) => Boolean(r.file?.path))
                .map(({ track, file }) => ({
                    id: track.id,
                    file_id: file?.id || "",
                    url: buildUrl(file?.bucket, file?.path) || "",
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
                    duration: track.duration,
                    is_stale: track.is_stale,
                    mime_type: file?.mime_type || null,
                    extension: file?.extension || null,
                    width: track.width || null,
                    height: track.height || null,
                    bandwidth: track.bandwidth || null,
                    container: track.container,
                    is_fragmented: track.is_fragmented,
                    stream_layout: track.stream_layout,
                    has_video: track.has_video,
                    has_audio: track.has_audio,
                    streams: track.streams || [],
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
                url: mainUrl,
                playback,
                cover_url: covers.length ? covers[0].url : null,
                covers: covers,
                width: primaryRow?.track.width || null,
                height: primaryRow?.track.height || null,
                tracks,
                position: startPosition + index,
            };
        });
    },

    /**
     * Single-pass fetch & DTO hydration for Media Detail.
     */
    async getDetail(media: typeof Media.$inferSelect) {
        const details = await this.getDetails([media]);
        return details[0];
    },

    /**
     * Lightweight Summary DTO for ultra-fast list/feed endpoints.
     * Performs a single SQL query pass for batch media items, fetching only primary content & cover tracks.
     * Skips heavy track tree building, multi-quality resolutions, and playback manifest generation.
     *
     * @note Use cases: Media gallery thumbnail grid, feed card previews, or search result lists.
     *       For full detail view pages (e.g., PostDetail), use `getDetails` instead.
     */
    async getSummaries(mediaList: Array<typeof Media.$inferSelect>, startPosition = 0) {
        if (!mediaList.length) return [];
        const mediaIds = mediaList.map((m) => m.id);

        const rows = await db
            .select({
                track: Track,
                file: DbFile,
            })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    inArray(Track.media_id, mediaIds),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                    or(eq(Track.purpose, TrackPurpose.COVER), eq(Track.purpose, TrackPurpose.CONTENT)),
                ),
            );

        const tracksByMedia = new Map<string, Array<{ track: typeof Track.$inferSelect; file: typeof DbFile.$inferSelect | null }>>();
        for (const row of rows) {
            if (!row.track.media_id) continue;
            const list = tracksByMedia.get(row.track.media_id) || [];
            list.push(row);
            tracksByMedia.set(row.track.media_id, list);
        }

        return mediaList.map((media, index) => {
            const items = tracksByMedia.get(media.id) || [];
            const covers = items.filter((i) => i.track.purpose === TrackPurpose.COVER);
            const contentTracks = items.filter((i) => i.track.purpose === TrackPurpose.CONTENT);
            const primaryContent = contentTracks.find((i) => i.track.is_primary) || contentTracks[0];
            const coverRow = covers[0];

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
                url: buildUrl(primaryContent?.file?.bucket, primaryContent?.file?.path),
                cover_url: buildUrl(coverRow?.file?.bucket, coverRow?.file?.path),
                width: primaryContent?.track.width || null,
                height: primaryContent?.track.height || null,
                playback: null,
                position: startPosition + index,
            };
        });
    },

    /**
     * Single authority DASH MPD manifest generation for a media item.
     */
    async getDashManifest(mediaId: string): Promise<string | null> {
        const rows = await db
            .select({
                track: Track,
                file: DbFile,
            })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE), eq(Track.sync_status, SyncStatus.COMPLETED)),
            );

        const isDashTrack = (t: typeof Track.$inferSelect) =>
            isDashCompatibleFormat(
                t.type,
                {
                    container: t.container,
                    is_fragmented: t.is_fragmented,
                    stream_layout: t.stream_layout,
                    has_video: t.has_video,
                    has_audio: t.has_audio,
                    streams: t.streams,
                },
                t.metadata,
            );

        const videoRows = rows.filter(
            (r) => r.track.type === TrackType.VIDEO && r.track.purpose === TrackPurpose.CONTENT && isDashTrack(r.track),
        );
        const audioRows = rows.filter(
            (r) => r.track.type === TrackType.AUDIO && r.track.purpose === TrackPurpose.CONTENT && isDashTrack(r.track),
        );

        if (videoRows.length === 0) return null;

        const mediaDuration = rows.reduce((max, r) => Math.max(max, r.track.duration || 0), 0);

        const toSegmentBase = (metadata: TrackMetadata): DashSegmentBase | null => {
            const segmentBase = metadata?.segment_base;
            if (!segmentBase?.index_range || !segmentBase.initialization) return null;
            return {
                initialization: segmentBase.initialization,
                index_range: segmentBase.index_range,
                timescale: segmentBase.timescale,
                earliest_presentation_time: segmentBase.earliest_presentation_time,
            };
        };

        const normalizeVideoCodec = (value: string | null | undefined) => {
            const codec = value?.toLowerCase() || "avc1.640028";
            if (["hevc", "h265", "h.265"].includes(codec)) return "hvc1.1.6.L150.90";
            if (["h264", "h.264", "avc"].includes(codec)) return "avc1.640028";
            if (codec === "av1") return "av01.0.08M.08";
            return codec;
        };

        const video = videoRows
            .map((r): DashVideoRepresentation | null => {
                if (!r.file?.bucket || !r.file?.path) return null;
                const url = buildUrl(r.file.bucket, r.file.path);
                if (!url) return null;
                const segmentBase = toSegmentBase(r.track.metadata);
                if (!segmentBase) return null;
                const stream = r.track.streams.find((s) => s.type === TrackType.VIDEO);

                return {
                    id: r.track.id,
                    url,
                    codec: normalizeVideoCodec(r.track.codec || stream?.codec),
                    bandwidth: stream?.bandwidth || 1_500_000,
                    width: r.track.width || stream?.width || 1280,
                    height: r.track.height || stream?.height || 720,
                    frame_rate: r.track.metadata?.frame_rate,
                    segment_base: segmentBase,
                };
            })
            .filter((item): item is DashVideoRepresentation => item !== null);

        const audio = audioRows
            .map((r): DashAudioRepresentation | null => {
                if (!r.file?.bucket || !r.file?.path) return null;
                const url = buildUrl(r.file.bucket, r.file.path);
                if (!url) return null;
                const segmentBase = toSegmentBase(r.track.metadata);
                if (!segmentBase) return null;
                const stream = r.track.streams.find((s) => s.type === TrackType.AUDIO);
                const language = r.track.language || stream?.language || null;
                const codec = r.track.codec || stream?.codec || "mp4a.40.2";

                return {
                    id: r.track.id,
                    url,
                    codec: codec.toLowerCase() === "aac" ? "mp4a.40.2" : codec,
                    bandwidth: stream?.bandwidth || 128_000,
                    language,
                    label: r.track.display_name || stream?.label || language || "Audio",
                    role: stream?.role || (r.track.is_default ? "main" : "alternate"),
                    channels: stream?.channels || 2,
                    sample_rate: stream?.sample_rate,
                    audio_group_id: r.track.metadata?.audio_group_id,
                    segment_base: segmentBase,
                };
            })
            .filter((item): item is DashAudioRepresentation => item !== null);

        if (video.length === 0) return null;

        return buildDashManifest({
            duration: mediaDuration,
            video,
            audio,
        });
    },

    async getCoversMap(mediaIds: string[]) {
        const map = new Map<string, PreviewItem[]>();
        if (!mediaIds.length) return map;

        const rows = await db
            .select({ track: Track, file: DbFile })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    inArray(Track.media_id, mediaIds),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                    eq(Track.purpose, TrackPurpose.COVER),
                ),
            );

        const qualityOrder: Record<Quality, number> = {
            [Quality.LOW]: 1,
            [Quality.MEDIUM]: 2,
            [Quality.HIGH]: 3,
        };

        for (const { track, file } of rows) {
            if (!track.media_id) continue;
            const list = map.get(track.media_id) || [];
            list.push({
                url: buildUrl(file?.bucket, file?.path),
                quality: track.quality,
                codec: track.codec,
            });
            list.sort((a, b) => (qualityOrder[a.quality] || 99) - (qualityOrder[b.quality] || 99));
            map.set(track.media_id, list);
        }
        return map;
    },

    async getVideosMap(mediaIds: string[]) {
        const map = new Map<string, PreviewItem[]>();
        if (!mediaIds.length) return map;

        const rows = await db
            .select({ track: Track, file: DbFile })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
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
    },
};
