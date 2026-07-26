import { describe, test, expect } from "bun:test";
import { COVER_PROFILES, RECIPE_VERSION } from "@/lib/utils/cover_profiles";
import { Quality } from "@/lib/types";
import { formatMediaDetail } from "@/lib/utils/media_mapper";
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

    test("formatMediaDetail sorts cover variants and fallback correctly", () => {
        const mockMedia: any = {
            id: "01900000-0000-7000-8000-000000000001",
            eid: "ext-1",
            post_id: null,
            source: "INTERNAL",
            title: "Test Image",
            description: "",
            type: MediaType.IMAGE,
            sort_order: 0,
            create_time: null,
            published_time: null,
            sync_status: SyncStatus.COMPLETED,
            last_error: null,
        };

        const mockFiles: any[] = [
            {
                track_id: "track-content",
                media_id: mockMedia.id,
                type: TrackType.IMAGE,
                purpose: TrackPurpose.CONTENT,
                is_original: true,
                quality: Quality.HIGH,
                priority: 0,
                metadata: {},
                variant_key: "image_primary",
                is_default: true,
                is_primary: true,
                file_id: "file-content",
                file_path: "path/to/content.jpeg",
                file_bucket: "test-bucket",
                width: 1920,
                height: 1080,
            },
            {
                track_id: "track-cover-low",
                media_id: mockMedia.id,
                type: TrackType.IMAGE,
                purpose: TrackPurpose.COVER,
                is_original: false,
                quality: Quality.LOW,
                priority: 10,
                metadata: {},
                variant_key: "cover:low:recipe:1",
                is_default: false,
                is_primary: false,
                file_id: "file-cover-low",
                file_path: "path/to/cover_low.avif",
                file_bucket: "test-bucket",
                width: 360,
                height: 203,
            },
            {
                track_id: "track-cover-medium",
                media_id: mockMedia.id,
                type: TrackType.IMAGE,
                purpose: TrackPurpose.COVER,
                is_original: false,
                quality: Quality.MEDIUM,
                priority: 20,
                metadata: {},
                variant_key: "cover:medium:recipe:1",
                is_default: false,
                is_primary: false,
                file_id: "file-cover-medium",
                file_path: "path/to/cover_medium.avif",
                file_bucket: "test-bucket",
                width: 720,
                height: 405,
            },
        ];

        const detail = formatMediaDetail(mockMedia, mockFiles);

        expect(detail.cover_variants.LOW).toBeDefined();
        expect(detail.cover_variants.MEDIUM).toBeDefined();
        expect(detail.cover_variants.LOW.url).toContain("path/to/cover_low.avif");
        expect(detail.cover_variants.MEDIUM.url).toContain("path/to/cover_medium.avif");
        // cover_url selects LOW by quality priority order
        expect(detail.cover_url).toContain("path/to/cover_low.avif");
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
});
