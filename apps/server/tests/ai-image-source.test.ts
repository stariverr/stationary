import { describe, expect, test } from "bun:test";
import { TrackPurpose, TrackType } from "../src/db/schema";
import { selectAiImageSource } from "../src/features/ai/image-source";
import { Quality } from "../src/lib/types";

type Candidate = Parameters<typeof selectAiImageSource>[0][number];

function candidate(
    id: string,
    purpose: TrackPurpose,
    quality: Quality,
    overrides: Partial<Candidate["track"]> = {},
): Candidate {
    return {
        track: {
            id,
            file_id: id,
            type: TrackType.IMAGE,
            purpose,
            quality,
            priority: purpose === TrackPurpose.CONTENT ? 0 : quality === Quality.LOW ? 10 : quality === Quality.MEDIUM ? 20 : 30,
            is_primary: false,
            is_default: false,
            is_generated: false,
            is_stale: false,
            metadata: {},
            ...overrides,
        },
        file: { id },
    };
}

describe("AI image source selection", () => {
    test("chooses the highest quality available cover over original content, regardless of priority", () => {
        const original = candidate("original", TrackPurpose.CONTENT, Quality.HIGH);
        const low = candidate("low", TrackPurpose.COVER, Quality.LOW);
        const medium = candidate("medium", TrackPurpose.COVER, Quality.MEDIUM);
        const high = candidate("high", TrackPurpose.COVER, Quality.HIGH);

        expect(selectAiImageSource([original, low, medium, high])).toBe(high);
        expect(selectAiImageSource([original, low, medium])).toBe(medium);
        expect(selectAiImageSource([original, low])).toBe(low);
    });

    test("uses only an available image content track when no usable cover exists", () => {
        const original = candidate("original", TrackPurpose.CONTENT, Quality.HIGH, { is_default: true });
        const alternate = candidate("alternate", TrackPurpose.CONTENT, Quality.HIGH, { priority: 2 });
        const stale = candidate("stale", TrackPurpose.COVER, Quality.HIGH, { is_stale: true });

        expect(selectAiImageSource([alternate, stale, original])).toBe(original);
        expect(selectAiImageSource([candidate("video", TrackPurpose.CONTENT, Quality.HIGH, { type: TrackType.VIDEO })])).toBeNull();
        expect(selectAiImageSource([])).toBeNull();
    });

    test("excludes covers derived from an obsolete content file", () => {
        const original = candidate("new-original", TrackPurpose.CONTENT, Quality.HIGH);
        const old = candidate("old-cover", TrackPurpose.COVER, Quality.HIGH, {
            is_generated: true,
            metadata: { source_file_id: "old-original" },
        });
        const current = candidate("current-cover", TrackPurpose.COVER, Quality.MEDIUM, {
            is_generated: true,
            metadata: { source_file_id: "new-original" },
        });

        expect(selectAiImageSource([original, old, current])).toBe(current);
        expect(selectAiImageSource([original, old])).toBe(original);
    });

    test("accepts an external video cover, but never embeds the video content as an image", () => {
        const video = candidate("video", TrackPurpose.CONTENT, Quality.HIGH, { type: TrackType.VIDEO });
        const cover = candidate("external-cover", TrackPurpose.COVER, Quality.MEDIUM);

        expect(selectAiImageSource([video, cover])).toBe(cover);
        expect(selectAiImageSource([video])).toBeNull();
    });
});
