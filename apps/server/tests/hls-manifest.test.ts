import { describe, expect, test } from "bun:test";
import { buildHlsMasterManifest, buildHlsSubtitleManifest, buildHlsVariantManifest } from "@/lib/utils/hls-manifest";

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

    test("marks exactly one audio and one subtitle rendition as default", () => {
        const audio = (track_id: string, is_default: boolean) => ({
            track_id,
            url: `https://cdn.example.test/${track_id}.mp4`,
            codec: "mp4a.40.2",
            bandwidth: 128_000,
            language: null,
            label: track_id,
            channels: 2,
            is_default,
        });
        const subtitle = (track_id: string, is_default: boolean) => ({
            track_id,
            url: `https://cdn.example.test/${track_id}.vtt`,
            language: null,
            label: track_id,
            is_default,
        });
        const video = [
            {
                track_id: "v",
                url: "https://cdn.example.test/v.mp4",
                codec: "avc1.640028",
                bandwidth: 1_500_000,
                width: 1280,
                height: 720,
            },
        ];
        const defaults = (manifest: string, type: string) =>
            manifest
                .split("\n")
                .filter((line) => line.startsWith(`#EXT-X-MEDIA:TYPE=${type}`) && line.includes("DEFAULT=YES"))
                .map((line) => /NAME="([^"]+)"/.exec(line)?.[1]);

        const marked = buildHlsMasterManifest({
            media_id: "m",
            video,
            audio: [audio("a1", false), audio("a2", true), audio("a3", true)],
            subtitle: [subtitle("s1", false), subtitle("s2", true)],
        });
        expect(defaults(marked, "AUDIO")).toEqual(["a2"]);
        expect(defaults(marked, "SUBTITLES")).toEqual(["s2"]);

        const unmarked = buildHlsMasterManifest({
            media_id: "m",
            video,
            audio: [audio("a1", false), audio("a2", false)],
            subtitle: [subtitle("s1", false), subtitle("s2", false)],
        });
        expect(defaults(unmarked, "AUDIO")).toEqual(["a1"]);
        expect(defaults(unmarked, "SUBTITLES")).toEqual(["s1"]);
    });

    test("lists every sidx segment as a byte range after the init map", () => {
        const manifest = buildHlsVariantManifest({
            file_url: "https://cdn.example.test/media.mp4",
            init: { offset: 0, length: 782 },
            segments: [
                { offset: 942, length: 74_043, duration: 2 },
                { offset: 74_985, length: 70_000, duration: 2.002 },
                { offset: 144_985, length: 30_000, duration: 1.5 },
            ],
            query_suffix: "?expires=1785852654&sig=abc",
        });
        const url = "https://cdn.example.test/media.mp4?expires=1785852654&sig=abc";

        expect(manifest.split("\n")).toEqual([
            "#EXTM3U",
            "#EXT-X-VERSION:6",
            "#EXT-X-TARGETDURATION:3",
            "#EXT-X-MEDIA-SEQUENCE:0",
            "#EXT-X-PLAYLIST-TYPE:VOD",
            `#EXT-X-MAP:URI="${url}",BYTERANGE="782@0"`,
            "#EXTINF:2.000000,",
            "#EXT-X-BYTERANGE:74043@942",
            url,
            "#EXTINF:2.002000,",
            "#EXT-X-BYTERANGE:70000@74985",
            url,
            "#EXTINF:1.500000,",
            "#EXT-X-BYTERANGE:30000@144985",
            url,
            "#EXT-X-ENDLIST",
        ]);
    });

    test("serves a subtitle file as a single segment", () => {
        const manifest = buildHlsSubtitleManifest({
            file_url: "https://cdn.example.test/sub.vtt",
            duration: 61.2,
            query_suffix: "?sig=abc",
        });

        expect(manifest).toContain("#EXT-X-TARGETDURATION:62");
        expect(manifest).toContain("#EXTINF:61.200000,\nhttps://cdn.example.test/sub.vtt?sig=abc");
        expect(manifest).not.toContain("EXT-X-MAP");
    });
});
