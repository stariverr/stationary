import { describe, expect, test } from "bun:test";
import { buildHlsMasterManifest, buildHlsVariantManifest } from "@/lib/utils/hls-manifest";

describe("HLS manifest generator", () => {
    test("builds master manifest with clean query parameters and signatures", () => {
        const manifest = buildHlsMasterManifest({
            media_id: "media-uuid-1234",
            video: [
                {
                    track_id: "track-v1",
                    url: "https://cdn.example.test/v1.mp4",
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                },
                {
                    track_id: "track-v2",
                    url: "https://cdn.example.test/v2.mp4",
                    codec: "avc1.640028",
                    bandwidth: 3_000_000,
                    width: 1920,
                    height: 1080,
                },
            ],
            audio: [
                {
                    track_id: "track-a1",
                    url: "https://cdn.example.test/a1.mp4",
                    codec: "mp4a.40.2",
                    bandwidth: 128_000,
                    language: "en",
                    label: "English",
                    channels: 2,
                },
            ],
            query_suffix: "?video_track_id=track-v1&audio_track_id=track-a1",
        });

        expect(manifest).toContain("#EXTM3U");
        expect(manifest).toContain("hls/track-a1/manifest.m3u8?video_track_id=track-v1&audio_track_id=track-a1&expires=");
        expect(manifest).toContain("hls/track-v1/manifest.m3u8?video_track_id=track-v1&audio_track_id=track-a1&expires=");
        expect(manifest).not.toContain("%3F");
        expect(manifest).not.toContain("??");
    });

    test("builds variant manifest with clean query parameters", () => {
        const manifest = buildHlsVariantManifest({
            file_url: "https://cdn.example.test/media.mp4",
            init_range: "0-1000",
            media_range: "1001-5000",
            duration: 10.5,
            query_suffix: "?expires=1785852654&sig=abc",
        });

        expect(manifest).toContain("#EXTM3U");
        expect(manifest).toContain("https://cdn.example.test/media.mp4?expires=1785852654&sig=abc");
        expect(manifest).not.toContain("%3F");
        expect(manifest).not.toContain("??");
    });
});
