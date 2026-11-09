import { and, asc, desc, eq, inArray, or, isNull } from "drizzle-orm";
import { db } from "@/global/db";
import { Media, Track, File as DbFile, DeleteStatus, SyncStatus, TrackPurpose, TrackType, type TrackMetadata } from "@/db/schema";

import { buildCdnUrl } from "@/lib/utils/cdn";
import { CoverService } from "./cover";
import { loadPreviewImages, NO_PREVIEWS } from "./preview";
import { toIsoTimestamp } from "@/lib/utils/time";
import { Quality } from "@/lib/types";
import { resolveMediaPlayback, type PlaybackTrackInput } from "@/lib/utils/media-playback";
import {
    buildDashManifest,
    type DashVideoRepresentation,
    type DashAudioRepresentation,
    type DashSegmentBase,
} from "@/lib/utils/dash-manifest";
import {
    buildHlsMasterManifest,
    buildHlsSubtitleManifest,
    buildHlsVariantManifest,
    type HlsVideoVariant,
    type HlsAudioVariant,
    type HlsSubtitleVariant,
} from "@/lib/utils/hls-manifest";
import { isDashCompatibleFormat } from "@/lib/utils/track-format";
import { parseSidx, type Mp4Segment } from "@/lib/utils/mp4-segment";
import { s3 } from "@/global/s3";
import { createPromiseCache } from "@/features/ai/promise-cache";

export interface VideoItem {
    url: string | null;
    quality: Quality;
    codec: string | null;
}

const buildUrl = (bucket: string | null | undefined, path: string | null | undefined) =>
    bucket && path ? buildCdnUrl(bucket, path) : null;

/** Parses an inclusive `start-end` byte range. */
const parseByteRange = (range: string | undefined) => {
    const match = range ? /^(\d+)-(\d+)$/.exec(range) : null;
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return end >= start ? { start, end } : null;
};

/** A sidx is 12 bytes per segment; 1 MiB covers far more segments than any real file has. */
const SIDX_MAX_BYTES = 1024 * 1024;
/** A file's bytes never change under the same id, so its segment list can be cached for a long time. */
const segmentListCache = createPromiseCache<Mp4Segment[]>(24 * 60 * 60 * 1000, 1000);

/** Reads the sidx at `indexRange` with one S3 range request and expands it into the file's segments. */
const readSegmentList = (file: { id: string; bucket: string; path: string }, indexRange: { start: number; end: number }) =>
    segmentListCache.getOrCreate(file.id, async () => {
        const bytes = await s3.read(file.path, { bucket: file.bucket, maxBytes: SIDX_MAX_BYTES, range: indexRange });
        return parseSidx(bytes, indexRange.start);
    });

export const MediaService = {
    /**
     * Single-pass batch fetch & DTO hydration for Media Details.
     * Performs a single SQL query pass for multiple media items and returns full playback, tracks, cover and previews.
     */
    async getDetails(mediaList: Array<typeof Media.$inferSelect>, startPosition = 0) {
        if (!mediaList.length) return [];
        const mediaIds = mediaList.map((m) => m.id);
        const [previewsByMedia, coversByMedia] = await Promise.all([loadPreviewImages(mediaIds), CoverService.loadUrls(mediaIds)]);

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
                previews: previewsByMedia.get(media.id) ?? NO_PREVIEWS,
                cover: coversByMedia.get(media.id) ?? null,
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

    /**
     * Single authority HLS Master m3u8 playlist generation for a media item.
     */
    async getHlsMasterManifest(
        mediaId: string,
        querySuffix?: string,
        options?: { videoTrackId?: string; audioTrackId?: string },
    ): Promise<string | null> {
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

        const normalizeVideoCodec = (value: string | null | undefined) => {
            const codec = value?.toLowerCase() || "avc1.640028";
            if (["hevc", "h265", "h.265"].includes(codec)) return "hvc1.1.6.L150.90";
            if (["h264", "h.264", "avc"].includes(codec)) return "avc1.640028";
            if (codec === "av1") return "av01.0.08M.08";
            return codec;
        };

        const video: HlsVideoVariant[] = [];
        const audio: HlsAudioVariant[] = [];
        const subtitle: HlsSubtitleVariant[] = [];

        for (const r of rows) {
            if (!r.file?.bucket || !r.file?.path) continue;
            const url = buildCdnUrl(r.file.bucket, r.file.path);
            if (!url) continue;

            const streams = r.track.streams || [];

            // 1. Process Video Streams
            const videoStreams = streams.filter((s) => s.type === TrackType.VIDEO);
            if (r.track.type === TrackType.VIDEO || videoStreams.length > 0) {
                if (videoStreams.length > 0) {
                    for (const s of videoStreams) {
                        video.push({
                            track_id: r.track.id,
                            stream_index: s.index,
                            url,
                            codec: normalizeVideoCodec(s.codec || r.track.codec),
                            bandwidth: s.bandwidth || r.track.bandwidth || 1_500_000,
                            width: s.width || r.track.width || 1280,
                            height: s.height || r.track.height || 720,
                            frame_rate: r.track.metadata?.frame_rate,
                        });
                    }
                } else {
                    video.push({
                        track_id: r.track.id,
                        stream_index: null,
                        url,
                        codec: normalizeVideoCodec(r.track.codec),
                        bandwidth: r.track.bandwidth || 1_500_000,
                        width: r.track.width || 1280,
                        height: r.track.height || 720,
                        frame_rate: r.track.metadata?.frame_rate,
                    });
                }
            }

            // 2. Process Audio Streams
            const audioStreams = streams.filter((s) => s.type === TrackType.AUDIO);
            if (r.track.type === TrackType.AUDIO || audioStreams.length > 0) {
                if (audioStreams.length > 0) {
                    for (const s of audioStreams) {
                        const language = s.language || r.track.language || null;
                        const codec = s.codec || r.track.codec || "mp4a.40.2";
                        audio.push({
                            track_id: r.track.id,
                            stream_index: s.index,
                            url,
                            codec: codec.toLowerCase() === "aac" ? "mp4a.40.2" : codec,
                            bandwidth: s.bandwidth || r.track.bandwidth || 128_000,
                            language,
                            label: s.label || r.track.display_name || language || `Audio ${audio.length + 1}`,
                            channels: s.channels || 2,
                            is_default: r.track.is_default,
                        });
                    }
                } else if (r.track.type === TrackType.AUDIO) {
                    const language = r.track.language || null;
                    const codec = r.track.codec || "mp4a.40.2";
                    audio.push({
                        track_id: r.track.id,
                        stream_index: null,
                        url,
                        codec: codec.toLowerCase() === "aac" ? "mp4a.40.2" : codec,
                        bandwidth: r.track.bandwidth || 128_000,
                        language,
                        label: r.track.display_name || language || `Audio ${audio.length + 1}`,
                        channels: 2,
                        is_default: r.track.is_default,
                    });
                }
            }

            // 3. Process Subtitle Streams
            const subtitleStreams = streams.filter((s) => s.type === TrackType.SUBTITLE);
            if (r.track.type === TrackType.SUBTITLE || subtitleStreams.length > 0) {
                if (subtitleStreams.length > 0) {
                    for (const s of subtitleStreams) {
                        const language = s.language || r.track.language || null;
                        subtitle.push({
                            track_id: r.track.id,
                            stream_index: s.index,
                            url,
                            language,
                            label: s.label || r.track.display_name || language || `Subtitle ${subtitle.length + 1}`,
                            is_default: r.track.is_default,
                        });
                    }
                } else if (r.track.type === TrackType.SUBTITLE) {
                    const language = r.track.language || null;
                    subtitle.push({
                        track_id: r.track.id,
                        stream_index: null,
                        url,
                        language,
                        label: r.track.display_name || language || `Subtitle ${subtitle.length + 1}`,
                        is_default: r.track.is_default,
                    });
                }
            }
        }

        let videoTrackId = options?.videoTrackId;
        let audioTrackId = options?.audioTrackId;

        if (querySuffix) {
            const cleanSuffix = querySuffix.replace(/^\?/, "");
            const params = new URLSearchParams(cleanSuffix);
            if (!videoTrackId) videoTrackId = params.get("video_track_id") ?? undefined;
            if (!audioTrackId) audioTrackId = params.get("audio_track_id") ?? undefined;
        }

        let filteredVideo = video;
        if (videoTrackId) {
            const matched = video.filter((v) => v.track_id === videoTrackId);
            if (matched.length > 0) filteredVideo = matched;
        }

        let filteredAudio = audio;
        if (audioTrackId) {
            const matched = audio.filter((a) => a.track_id === audioTrackId);
            if (matched.length > 0) filteredAudio = matched;
        }

        if (filteredVideo.length === 0) return null;

        return buildHlsMasterManifest({
            media_id: mediaId,
            video: filteredVideo,
            audio: filteredAudio,
            subtitle,
            query_suffix: querySuffix,
        });
    },

    /**
     * Single authority HLS Variant m3u8 playlist generation for a track.
     */
    async getHlsVariantManifest(mediaId: string, trackId: string, querySuffix?: string): Promise<string | null> {
        const rows = await db
            .select({
                track: Track,
                file: DbFile,
            })
            .from(Track)
            .leftJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    eq(Track.media_id, mediaId),
                    eq(Track.id, trackId),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                ),
            );

        const row = rows[0];
        if (!row || !row.file || !row.file.bucket || !row.file.path) return null;
        const fileUrl = buildCdnUrl(row.file.bucket, row.file.path);
        if (!fileUrl) return null;

        if (row.track.type === TrackType.SUBTITLE) {
            return buildHlsSubtitleManifest({
                file_url: fileUrl,
                duration: row.track.duration || 0,
                query_suffix: querySuffix,
            });
        }

        const segmentBase = row.track.metadata?.segment_base;
        const init = parseByteRange(segmentBase?.initialization);
        const indexRange = parseByteRange(segmentBase?.index_range);
        if (!init || !indexRange) return null;

        const segments = await readSegmentList({ id: row.file.id, bucket: row.file.bucket, path: row.file.path }, indexRange);

        return buildHlsVariantManifest({
            file_url: fileUrl,
            init: { offset: init.start, length: init.end - init.start + 1 },
            segments,
            query_suffix: querySuffix,
        });
    },

    /** The URL of each media's primary content file (the default, else first by priority). */
    async getContentUrls(mediaIds: string[]): Promise<Map<string, string>> {
        if (!mediaIds.length) return new Map();
        const rows = await db
            .selectDistinctOn([Track.media_id], { mediaId: Track.media_id, bucket: DbFile.bucket, path: DbFile.path })
            .from(Track)
            .innerJoin(DbFile, and(eq(Track.file_id, DbFile.id), eq(DbFile.delete_status, DeleteStatus.ACTIVE)))
            .where(
                and(
                    inArray(Track.media_id, mediaIds),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                    eq(Track.purpose, TrackPurpose.CONTENT),
                ),
            )
            .orderBy(Track.media_id, desc(Track.is_primary), asc(Track.priority));
        return new Map(rows.map((row) => [row.mediaId, buildCdnUrl(row.bucket, row.path)]));
    },

    async getVideosMap(mediaIds: string[]) {
        const map = new Map<string, VideoItem[]>();
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
