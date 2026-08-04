import { describe, expect, test } from "bun:test";
import { Quality } from "@/lib/types";
import { TrackPurpose, TrackStreamLayout, TrackType } from "@/db/schema";
import { cleanTrackMetadata, deriveTrackFormat, normalizeIncomingTrack } from "@/lib/utils/track-format";
import { resolveMediaPlayback } from "@/lib/utils/media-playback";
import { buildDashManifest } from "@/lib/utils/dash-manifest";

describe("E2E Track Pipeline & Regression Test Suite", () => {
    test("preserves language, codec, subtitle format and dimensions during normalization", () => {
        const rawInput = {
            type: TrackType.SUBTITLE,
            purpose: TrackPurpose.CONTENT,
            quality: Quality.HIGH,
            metadata: {
                language: "zh-CN",
                format: "srt",
                codecs: "vtt",
                width: 1920,
                height: 1080,
                duration: 120,
            },
        };

        const normalized = normalizeIncomingTrack(rawInput);

        expect(normalized.language).toBe("zh-CN");
        expect(normalized.codec).toBe("vtt");
        expect(normalized.metadata.format).toBe("srt");
        expect(normalized.metadata.width).toBe(1920);
        expect(normalized.metadata.height).toBe(1080);
        expect(normalized.metadata.duration).toBe(120);
    });

    test("resolves media playback and generates valid DASH MPD manifest for separated fMP4 tracks", () => {
        const videoTrack = {
            track_id: "track-video-1080p",
            type: TrackType.VIDEO,
            purpose: TrackPurpose.CONTENT,
            priority: 0,
            quality: Quality.HIGH,
            is_default: true,
            is_primary: true,
            display_name: "1080p Video",
            language: null,
            codec: "avc1.640028",
            metadata: {
                segment_base: {
                    initialization: "0-899",
                    index_range: "900-5000",
                },
            },
            container: "mp4",
            is_fragmented: true,
            stream_layout: TrackStreamLayout.VIDEO_ONLY,
            has_video: true,
            has_audio: false,
            streams: [{ index: 0, type: TrackType.VIDEO as const, codec: "avc1.640028", width: 1920, height: 1080 }],
            url: "https://cdn.example.test/video.mp4",
            mime_type: "video/mp4",
            width: 1920,
            height: 1080,
        };

        const audioTrack = {
            track_id: "track-audio-en",
            type: TrackType.AUDIO,
            purpose: TrackPurpose.CONTENT,
            priority: 1,
            quality: Quality.HIGH,
            is_default: true,
            is_primary: false,
            display_name: "English Audio",
            language: "en",
            codec: "mp4a.40.2",
            metadata: {
                segment_base: {
                    initialization: "0-499",
                    index_range: "500-2000",
                },
            },
            container: "mp4",
            is_fragmented: true,
            stream_layout: TrackStreamLayout.AUDIO_ONLY,
            has_video: false,
            has_audio: true,
            streams: [{ index: 1, type: TrackType.AUDIO as const, codec: "mp4a.40.2", language: "en" }],
            url: "https://cdn.example.test/audio.mp4",
            mime_type: "audio/mp4",
            width: null,
            height: null,
        };

        const playback = resolveMediaPlayback("media-e2e-1", [videoTrack, audioTrack]);

        expect(playback.protocol).toBe("DASH");
        expect(playback.variants.length).toBeGreaterThan(0);
        expect(playback.audio_tracks.length).toBe(1);

        const manifestXml = buildDashManifest({
            duration: 120,
            video: [
                {
                    id: videoTrack.track_id,
                    url: videoTrack.url,
                    codec: videoTrack.codec,
                    bandwidth: 5_000_000,
                    width: 1920,
                    height: 1080,
                    segment_base: {
                        initialization: "0-899",
                        index_range: "900-5000",
                    },
                },
            ],
            audio: [
                {
                    id: audioTrack.track_id,
                    url: audioTrack.url,
                    codec: audioTrack.codec,
                    bandwidth: 128_000,
                    language: "en",
                    label: "English Audio",
                    role: "main",
                    channels: 2,
                    segment_base: {
                        initialization: "0-499",
                        index_range: "500-2000",
                    },
                },
            ],
        });

        expect(manifestXml).toContain('<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"');
        expect(manifestXml).toContain('<Representation id="track-video-1080p"');
        expect(manifestXml).toContain('<Representation id="track-audio-en"');
    });
});
