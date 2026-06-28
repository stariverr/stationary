import { describe, expect, test } from "bun:test";
import { generateDeterministicVariantKey, normalizeVariantKey } from "../src/lib/utils/track";

const sourceFiles = {
    trackService: () => Bun.file("src/services/track.ts").text(),
    mediaApi: () => Bun.file("src/api/media.ts").text(),
};

describe("Track Variant Key Generation", () => {
    test("normalizeVariantKey behaves correctly", () => {
        expect(normalizeVariantKey("1080p-H264-v1")).toBe("1080p-h264-v1");
        expect(normalizeVariantKey("Subtitle (zh-CN)")).toBe("subtitle-zh-cn");
        expect(normalizeVariantKey("!!!---!!!")).toBe("variant"); // non-empty fallback
    });

    test("generateDeterministicVariantKey for Video tracks", () => {
        const track = {
            type: "VIDEO",
            purpose: "CONTENT",
            quality: "ORIGINAL",
            priority: 0,
            metadata: { codecs: "hvc1.1.6.L150.90" },
        };
        // original-video when priority is 0 and quality is ORIGINAL
        expect(generateDeterministicVariantKey(track)).toBe("original-video");

        // non-original, with priority
        const track2 = {
            type: "VIDEO",
            purpose: "CONTENT",
            quality: "HIGH",
            priority: 2,
            metadata: { codecs: "h264" },
        };
        const file2 = {
            height: 1080,
        };
        expect(generateDeterministicVariantKey(track2, file2)).toBe("1080p-avc-rank2");
    });

    test("generateDeterministicVariantKey for Audio tracks", () => {
        const track = {
            type: "AUDIO",
            purpose: "CONTENT",
            quality: "ORIGINAL",
            priority: 0,
            metadata: { language: "zh_CN", codecs: "mp4a.40.2" },
        };
        expect(generateDeterministicVariantKey(track)).toBe("zh-cn-mp4a402");
    });

    test("generateDeterministicVariantKey for Subtitle tracks", () => {
        const track = {
            type: "SUBTITLE",
            purpose: "CONTENT",
            quality: "ORIGINAL",
            priority: 0,
            metadata: { language: "en_US", format: "vtt" },
        };
        expect(generateDeterministicVariantKey(track)).toBe("en-us-vtt");
    });

    test("generateDeterministicVariantKey for Image tracks", () => {
        const track = {
            type: "IMAGE",
            purpose: "CONTENT",
            quality: "ORIGINAL",
            priority: 0,
        };
        expect(generateDeterministicVariantKey(track)).toBe("original");

        const track2 = {
            type: "IMAGE",
            purpose: "CONTENT",
            quality: "MEDIUM",
            priority: 1,
        };
        const file2 = { width: 800, height: 600, extension: "png" };
        expect(generateDeterministicVariantKey(track2, file2)).toBe("png-800x600-rank1");
    });
});

describe("TrackService & API Static Compliance", () => {
    test("TrackService exposes replaceFile and addOrReplaceTrack using physical columns", async () => {
        const content = await sourceFiles.trackService();
        expect(content).toContain("replaceFile(mediaId: string, trackId: string, fileData: FileData)");
        expect(content).toContain("is_stale: true");
        expect(content).toContain("is_default");
        expect(content).toContain("variant_key");
        expect(content).toContain("language: extractedLang");
        expect(content).toContain("codec: extractedCodec");
    });

    test("media API router implements replacement and update routes", async () => {
        const content = await sourceFiles.mediaApi();
        expect(content).toContain("/:id/tracks/:trackId/replace-file");
        expect(content).toContain("TrackService.replaceFile(");
        expect(content).toContain("variant_key: f.variant_key");
        expect(content).toContain("is_default: f.is_default");
        expect(content).toContain("language: f.language");
        expect(content).toContain("codec: f.codec");
        expect(content).toContain("is_stale: f.is_stale");
    });
});
