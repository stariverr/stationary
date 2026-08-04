import { describe, expect, test } from "bun:test";
import { buildDashManifest, type DashSegmentBase } from "@/lib/utils/dash-manifest";

const segmentBase: DashSegmentBase = {
    initialization: "0-899",
    index_range: "900-5000",
    timescale: 1_000,
    earliest_presentation_time: "0",
};

describe("DASH manifest generator", () => {
    test("emits one video adaptation set and distinct logical audio adaptation sets", () => {
        const manifest = buildDashManifest({
            duration: 120.5,
            video: [
                {
                    id: "video-1080",
                    url: "https://cdn.example.test/video-1080.mp4?token=a&b=c",
                    codec: "avc1.640028",
                    bandwidth: 5_000_000,
                    width: 1920,
                    height: 1080,
                    frame_rate: 30,
                    segment_base: segmentBase,
                },
                {
                    id: "video-720",
                    url: "https://cdn.example.test/video-720.mp4",
                    codec: "avc1.4d401f",
                    bandwidth: 2_500_000,
                    width: 1280,
                    height: 720,
                    segment_base: segmentBase,
                },
            ],
            audio: [
                {
                    id: "audio-en-high",
                    url: "https://cdn.example.test/audio-en-high.mp4",
                    codec: "mp4a.40.2",
                    bandwidth: 192_000,
                    language: "en",
                    label: "English & Original",
                    role: "main",
                    channels: 2,
                    sample_rate: 48_000,
                    segment_base: segmentBase,
                },
                {
                    id: "audio-en-low",
                    url: "https://cdn.example.test/audio-en-low.mp4",
                    codec: "mp4a.40.2",
                    bandwidth: 96_000,
                    language: "en",
                    label: "English & Original",
                    role: "main",
                    channels: 2,
                    sample_rate: 48_000,
                    segment_base: segmentBase,
                },
                {
                    id: "audio-ja",
                    url: "https://cdn.example.test/audio-ja.mp4",
                    codec: "mp4a.40.2",
                    bandwidth: 128_000,
                    language: "ja",
                    label: "Japanese",
                    role: "alternate",
                    channels: 6,
                    segment_base: segmentBase,
                },
            ],
        });

        expect(manifest.match(/contentType="video"/g)).toHaveLength(1);
        expect(manifest.match(/contentType="audio"/g)).toHaveLength(2);
        expect(manifest.match(/<Representation id="video-/g)).toHaveLength(2);
        expect(manifest).toContain('lang="en"');
        expect(manifest).toContain('lang="ja"');
        expect(manifest).toContain('value="6"');
        expect(manifest).toContain("English &amp; Original");
        expect(manifest).toContain("token=a&amp;b=c");
        expect(manifest).not.toContain("video_track_id");
        expect(manifest).not.toContain("audio_track_id");
    });

    test("produces a valid static video-only manifest", () => {
        const manifest = buildDashManifest({
            duration: 0,
            video: [
                {
                    id: "video-only",
                    url: "https://cdn.example.test/video.mp4",
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                    segment_base: segmentBase,
                },
            ],
            audio: [],
        });

        expect(manifest.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
        expect(manifest).toContain('mediaPresentationDuration="PT0S"');
        expect(manifest).toContain("</MPD>");
        expect(manifest).not.toContain('contentType="audio"');
    });
});
