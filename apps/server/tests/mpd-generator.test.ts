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
                    codec: "avc1.640028",
                    bandwidth: 5_000_000,
                    width: 1920,
                    height: 1080,
                    frame_rate: 30,
                    segments: { kind: "base", url: "https://cdn.example.test/video-1080.mp4?token=a&b=c", segment_base: segmentBase },
                },
                {
                    id: "video-720",
                    codec: "avc1.4d401f",
                    bandwidth: 2_500_000,
                    width: 1280,
                    height: 720,
                    segments: { kind: "base", url: "https://cdn.example.test/video-720.mp4", segment_base: segmentBase },
                },
            ],
            audio: [
                {
                    id: "audio-en-high",
                    codec: "mp4a.40.2",
                    bandwidth: 192_000,
                    language: "en",
                    label: "English & Original",
                    role: "main",
                    channels: 2,
                    sample_rate: 48_000,
                    segments: { kind: "base", url: "https://cdn.example.test/audio-en-high.mp4", segment_base: segmentBase },
                },
                {
                    id: "audio-en-low",
                    codec: "mp4a.40.2",
                    bandwidth: 96_000,
                    language: "en",
                    label: "English & Original",
                    role: "main",
                    channels: 2,
                    sample_rate: 48_000,
                    segments: { kind: "base", url: "https://cdn.example.test/audio-en-low.mp4", segment_base: segmentBase },
                },
                {
                    id: "audio-ja",
                    codec: "mp4a.40.2",
                    bandwidth: 128_000,
                    language: "ja",
                    label: "Japanese",
                    role: "alternate",
                    channels: 6,
                    segments: { kind: "base", url: "https://cdn.example.test/audio-ja.mp4", segment_base: segmentBase },
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
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                    segments: { kind: "base", url: "https://cdn.example.test/video.mp4", segment_base: segmentBase },
                },
            ],
            audio: [],
        });

        expect(manifest.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
        expect(manifest).toContain('mediaPresentationDuration="PT0S"');
        expect(manifest).toContain("</MPD>");
        expect(manifest).not.toContain('contentType="audio"');
    });

    test("shares one Period offset so the video's EPT lead over audio survives", () => {
        // ffmpeg libx264 with B-frames: video starts at 1024/15360 s, AAC audio at 0.
        const manifest = buildDashManifest({
            duration: 20,
            video: [
                {
                    id: "video",
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                    segments: { kind: "base", url: "https://cdn.example.test/video.mp4", segment_base: { initialization: "0-781", index_range: "782-941", timescale: 15_360, earliest_presentation_time: "1024" } },
                },
            ],
            audio: [
                {
                    id: "audio",
                    codec: "mp4a.40.2",
                    bandwidth: 128_000,
                    language: "en",
                    label: "English",
                    role: "main",
                    channels: 2,
                    segments: { kind: "base", url: "https://cdn.example.test/audio.mp4", segment_base: { initialization: "0-731", index_range: "732-783", timescale: 48_000, earliest_presentation_time: "0" } },
                },
            ],
        });

        expect(manifest).not.toContain("presentationTimeOffset");
        expect(manifest).toContain('indexRange="782-941" timescale="15360">');
    });

    test("converts the smallest EPT into each Representation's timescale exactly", () => {
        const representation = (id: string, timescale: number, ept: string) => ({
            id,
            codec: "mp4a.40.2",
            bandwidth: 128_000,
            language: id,
            label: id,
            role: "main",
            channels: 2,
            segments: { kind: "base" as const, url: `https://cdn.example.test/${id}.mp4`, segment_base: { initialization: "0-99", index_range: "100-199", timescale, earliest_presentation_time: ept } },
        });
        // Video starts at 10 s + 1 tick of a 90 kHz clock; the earliest stream starts at exactly 10 s.
        // Large values on purpose: they are past 2^53 after scaling, where float math would round.
        const manifest = buildDashManifest({
            duration: 20,
            video: [
                {
                    id: "video",
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                    segments: { kind: "base", url: "https://cdn.example.test/video.mp4", segment_base: { initialization: "0-99", index_range: "100-199", timescale: 90_000, earliest_presentation_time: "900001" } },
                },
            ],
            audio: [representation("a", 48_000, "480000"), representation("b", 1_000_000_007, "10000000071")],
        });

        const offsets = [...manifest.matchAll(/presentationTimeOffset="(\d+)"/g)].map((match) => match[1]);
        // video 10 s @ 90 kHz, audio a 10 s @ 48 kHz, audio b 10 s @ 1000000007 Hz
        expect(offsets).toEqual(["900000", "480000", "10000000070"]);
    });

    test("addresses packaged streams with a SegmentTemplate timeline and zeroes the Period offset", () => {
        const manifest = buildDashManifest({
            duration: 14,
            video: [
                {
                    id: "video",
                    codec: "avc1.640028",
                    bandwidth: 1_500_000,
                    width: 1280,
                    height: 720,
                    segments: {
                        kind: "template",
                        timescale: 15_360,
                        initialization: "/api/media/m/packaged/video/init.mp4?expires=1&sig=a",
                        media: "/api/media/m/packaged/video/$Number$.m4s?expires=1&sig=a",
                        timeline: [
                            { time: 0, duration: 92_160 },
                            { time: 92_160, duration: 92_160 },
                            { time: 184_320, duration: 30_720 },
                        ],
                    },
                },
            ],
            audio: [
                {
                    id: "audio",
                    codec: "mp4a.40.2",
                    bandwidth: 128_000,
                    language: "ja",
                    label: "Japanese",
                    role: "main",
                    channels: 2,
                    // An fMP4 original that starts late: with a packaged stream in the Period it keeps its own time.
                    segments: { kind: "base", url: "https://cdn.example.test/a.mp4", segment_base: { initialization: "0-9", index_range: "10-99", timescale: 48_000, earliest_presentation_time: "4800" } },
                },
            ],
        });
        expect(manifest).toContain('<SegmentTemplate timescale="15360" initialization="/api/media/m/packaged/video/init.mp4?expires=1&amp;sig=a" media="/api/media/m/packaged/video/$Number$.m4s?expires=1&amp;sig=a" startNumber="0">');
        expect(manifest).toContain('<S t="0" d="92160" r="1" /><S t="184320" d="30720" />');
        expect(manifest).not.toContain("presentationTimeOffset");
    });
});
