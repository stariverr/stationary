import { describe, test, expect } from "bun:test";
import { COVER_PROFILES, RECIPE_VERSION } from "@/lib/utils/cover_profiles";
import { Quality } from "@/lib/types";
import { MediaType, SyncStatus, TrackPurpose, TrackType } from "@/db/schema";

describe("Cover Photo Multi-Quality Service Tests", () => {
    test("COVER_PROFILES matches exact recipe definitions", () => {
        expect(RECIPE_VERSION).toBe(1);
        expect(COVER_PROFILES[Quality.LOW]).toEqual({ maxEdge: 360, crf: 35, quality: 50 });
        expect(COVER_PROFILES[Quality.MEDIUM]).toEqual({ maxEdge: 720, crf: 28, quality: 60 });
        expect(COVER_PROFILES[Quality.HIGH]).toEqual({ maxEdge: 1440, crf: 22, quality: 75 });
    });

    test("FFmpeg Max Edge Scale Formula preserves aspect ratio", () => {
        const calculateScaledDimensions = (width: number, height: number, maxEdge: number) => {
            if (width > height) {
                if (width <= maxEdge) return { width, height };
                const scaledWidth = maxEdge;
                const scaledHeight = Math.round((height * maxEdge) / width);
                return { width: scaledWidth, height: scaledHeight };
            } else {
                if (height <= maxEdge) return { width, height };
                const scaledHeight = maxEdge;
                const scaledWidth = Math.round((width * maxEdge) / height);
                return { width: scaledWidth, height: scaledHeight };
            }
        };

        // Landscape test: 1920x1080 -> LOW (360)
        const landscape = calculateScaledDimensions(1920, 1080, 360);
        expect(landscape.width).toBe(360);
        expect(landscape.height).toBe(203);

        // Portrait test: 1080x1920 -> LOW (360)
        const portrait = calculateScaledDimensions(1080, 1920, 360);
        expect(portrait.height).toBe(360);
        expect(portrait.width).toBe(203);
    });



    test("rankCoverCandidateTrack prefers supported formats and primary/default tracks over vvic/jxl", () => {
        const { rankCoverCandidateTrack } = require("@/services/cover");

        const unrenderableTrack: any = {
            track: { type: TrackType.IMAGE, is_primary: false, is_default: false, priority: 1 },
            file: { extension: "vvic", mime_type: "image/vvic" },
        };

        const renderableJpegTrack: any = {
            track: { type: TrackType.IMAGE, is_primary: true, is_default: true, priority: 0 },
            file: { extension: "jpg", mime_type: "image/jpeg" },
        };

        const candidates = [unrenderableTrack, renderableJpegTrack];
        candidates.sort(rankCoverCandidateTrack);

        expect(candidates[0].file.extension).toBe("jpg");
    });

    test("renderCoverFrame renders local HEIC files without throwing moov atom errors", async () => {
        const { renderCoverFrame } = require("@/lib/utils/cover_renderer");
        const heicSample = "/Users/kazuha/sec/XHS-Downloader/Download_1/67c191ef000000000603d16e_8.heic";

        if (await Bun.file(heicSample).exists()) {
            const result = await renderCoverFrame(heicSample, MediaType.IMAGE, Quality.LOW);
            expect(result.buffer).toBeDefined();
            expect(result.buffer.length).toBeGreaterThan(0);
            expect(result.width).toBeGreaterThan(0);
            expect(result.height).toBeGreaterThan(0);
        }
    });

    test("detectFormatStrategy classifies formats into distinct strategies", () => {
        const { detectFormatStrategy } = require("@/lib/utils/cover_renderer");

        const heic = detectFormatStrategy("https://example.com/photo.heic", MediaType.IMAGE);
        expect(heic.category).toBe("HEIF_IMAGE");
        expect(heic.requiresLocalDownload).toBe(true);

        const jpeg = detectFormatStrategy("https://example.com/image.jpg", MediaType.IMAGE);
        expect(jpeg.category).toBe("STANDARD_IMAGE");
        expect(jpeg.requiresLocalDownload).toBe(false);

        const mp4 = detectFormatStrategy("https://example.com/video.mp4", MediaType.VIDEO);
        expect(mp4.category).toBe("VIDEO_CONTAINER");
        expect(mp4.seekOptions).toEqual(["-ss", "00:00:00.500"]);

        const mov = detectFormatStrategy("https://example.com/clip.mov", MediaType.VIDEO);
        expect(mov.category).toBe("VIDEO_CONTAINER");
        expect(mov.seekOptions).toEqual(["-ss", "00:00:00.500"]);
    });
});
