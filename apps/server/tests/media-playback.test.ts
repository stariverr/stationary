import { expect, test } from "bun:test";
import { TrackPurpose, TrackStreamLayout, TrackType } from "@/db/schema";
import { resolveMediaPlayback, type PlaybackTrackInput } from "@/lib/utils/media-playback";
import { deriveTrackFormat, isDashCompatibleTrack } from "@/lib/utils/track-format";
import { Quality } from "@/lib/types";

const makeTrack = (overrides: Partial<PlaybackTrackInput>): PlaybackTrackInput => ({
    track_id: "track-1",
    type: TrackType.VIDEO,
    purpose: TrackPurpose.CONTENT,
    priority: 0,
    quality: Quality.HIGH,
    is_default: true,
    is_primary: true,
    display_name: null,
    language: null,
    codec: null,
    metadata: {},
    container: "mp4",
    is_fragmented: false,
    stream_layout: TrackStreamLayout.MUXED,
    has_video: true,
    has_audio: true,
    streams: [],
    url: "https://cdn.example.test/video.mp4",
    mime_type: "video/mp4",
    width: 1920,
    height: 1080,
    ...overrides,
});

test("resolves muxed MP4 as progressive playback and preserves internal audio streams", () => {
    const playback = resolveMediaPlayback("media-1", [
        makeTrack({
            streams: [
                { index: 0, type: TrackType.VIDEO, codec: "avc1" },
                { index: 1, type: TrackType.AUDIO, language: "en", label: "English", is_default: true },
                { index: 2, type: TrackType.AUDIO, language: "ja", label: "日本語" },
            ],
        }),
        makeTrack({
            track_id: "external-audio",
            type: TrackType.AUDIO,
            purpose: TrackPurpose.CONTENT,
            is_primary: false,
            url: "https://cdn.example.test/audio.mp4",
            mime_type: "audio/mp4",
            stream_layout: TrackStreamLayout.AUDIO_ONLY,
            has_video: false,
            has_audio: true,
            display_name: "Commentary",
        }),
        makeTrack({
            track_id: "subtitle-en",
            type: TrackType.SUBTITLE,
            purpose: TrackPurpose.CONTENT,
            is_primary: false,
            url: "https://cdn.example.test/subtitle.vtt",
            mime_type: "text/vtt",
            container: "vtt",
            stream_layout: TrackStreamLayout.TEXT_ONLY,
            has_video: false,
            has_audio: false,
            metadata: { format: "vtt" },
            display_name: "English subtitles",
        }),
    ]);

    expect(playback.protocol).toBe("PROGRESSIVE");
    expect(playback.url).toBe("https://cdn.example.test/video.mp4");
    expect(playback.variants).toHaveLength(1);
    expect(playback.audio_tracks.map((track) => track.source)).toEqual(["INTERNAL", "INTERNAL", "EXTERNAL"]);
    expect(playback.audio_tracks[0]?.mime_type).toBe("audio/mp4");
    expect(playback.audio_tracks[0]?.selectable).toBe(false);
    expect(playback.audio_tracks[2]?.selectable).toBe(false);
    expect(playback.capabilities.audio_switching).toBe(true);
    expect(playback.capabilities.subtitle_switching).toBe(true);
    expect(playback.capabilities.protocol_supports_switching).toBe(false);
    expect(playback.subtitle_tracks[0]?.url).toBe("https://cdn.example.test/subtitle.vtt");
});

test("resolves separated fMP4 tracks as DASH playback with selectable variants", () => {
    const video = makeTrack({
        track_id: "video-fmp4",
        quality: Quality.HIGH,
        is_fragmented: true,
        stream_layout: TrackStreamLayout.VIDEO_ONLY,
        has_audio: false,
        streams: [{ index: 0, type: TrackType.VIDEO, codec: "avc1" }],
        width: 1920,
        height: 1080,
        metadata: {
            type: "fmp4",
            codecs: "avc1",
            bandwidth: 5_000_000,
            segment_base: {
                initialization: "0-914",
                index_range: "915-5000",
            },
        },
    });
    const audio = makeTrack({
        track_id: "audio-fmp4",
        type: TrackType.AUDIO,
        is_primary: false,
        quality: Quality.HIGH,
        is_fragmented: true,
        stream_layout: TrackStreamLayout.AUDIO_ONLY,
        has_video: false,
        has_audio: true,
        url: "https://cdn.example.test/audio.m4s",
        mime_type: "audio/mp4",
        metadata: {
            type: "fmp4",
            codecs: "aac",
            segment_base: {
                initialization: "0-836",
                index_range: "837-5000",
            },
        },
    });

    const playback = resolveMediaPlayback("media-2", [video, audio]);

    expect(playback.protocol).toBe("DASH");
    expect(playback.url?.startsWith("/api/media/media-2/manifest.mpd")).toBe(true);
    expect(playback.variants[0]?.url.startsWith("/api/media/media-2/hls/")).toBe(true);
    expect(playback.variants[0]?.label).toBe("1080p");
    expect(playback.variants[0]?.bandwidth).toBe(5_000_000);
    expect(playback.audio_tracks[0]?.select_url).toBeNull();
    expect(playback.capabilities.audio_switching).toBe(false);
    expect(playback.capabilities.protocol_supports_switching).toBe(true);
    expect(isDashCompatibleTrack(video)).toBe(true);
    expect(isDashCompatibleTrack(makeTrack({ stream_layout: TrackStreamLayout.MUXED, is_fragmented: true }))).toBe(false);
});

test("keeps ordinary WebM on a direct progressive URL", () => {
    const playback = resolveMediaPlayback("media-3", [
        makeTrack({
            container: "webm",
            is_fragmented: false,
            stream_layout: TrackStreamLayout.MUXED,
            url: "https://cdn.example.test/video.webm",
            mime_type: "video/webm",
        }),
    ]);

    expect(playback.protocol).toBe("PROGRESSIVE");
    expect(playback.url).toBe("https://cdn.example.test/video.webm");
    expect(playback.mime_type).toBe("video/webm");
    expect(playback.capabilities.protocol_supports_switching).toBe(false);
});

test("does not select silent DASH video when a muxed MP4 fallback is available", () => {
    const playback = resolveMediaPlayback("media-4", [
        makeTrack({
            track_id: "video-fmp4",
            is_fragmented: true,
            stream_layout: TrackStreamLayout.VIDEO_ONLY,
            has_audio: false,
            metadata: {
                type: "fmp4",
                segment_base: {
                    initialization: "0-914",
                    index_range: "915-5000",
                },
            },
        }),
        makeTrack({
            track_id: "video-muxed",
            is_primary: false,
            is_default: false,
            url: "https://cdn.example.test/fallback.mp4",
            is_fragmented: false,
            stream_layout: TrackStreamLayout.MUXED,
            has_audio: true,
        }),
    ]);

    expect(playback.protocol).toBe("PROGRESSIVE");
    expect(playback.track_id).toBe("video-muxed");
    expect(playback.url).toBe("https://cdn.example.test/fallback.mp4");
});

test("explicit false format fields override metadata and progressive inference", () => {
    const format = deriveTrackFormat({
        type: TrackType.VIDEO,
        metadata: {
            has_audio: true,
            is_fragmented: true,
            streams: [{ index: 1, type: TrackType.AUDIO }],
        },
        has_audio: false,
        is_fragmented: false,
        streams: [],
        file: { mime_type: "video/mp4", extension: "mp4" },
    });

    expect(format.has_audio).toBe(false);
    expect(format.is_fragmented).toBe(false);
    expect(format.stream_layout).toBe(TrackStreamLayout.VIDEO_ONLY);
});

test("ordinary progressive video containers infer a muxed audio layout when no probe data exists", () => {
    const format = deriveTrackFormat({
        type: TrackType.VIDEO,
        file: { mime_type: "video/webm", extension: "webm" },
    });

    expect(format.container).toBe("webm");
    expect(format.has_video).toBe(true);
    expect(format.has_audio).toBe(true);
    expect(format.stream_layout).toBe(TrackStreamLayout.MUXED);
});
