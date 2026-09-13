import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

describe("media list query", () => {
    test("fetches covers and videos maps in parallel", async () => {
        const source = await Bun.file(resolveSrc("src/api/media.ts")).text();

        expect(source).toContain("MediaService.getCoversMap(mediaIds)");
        expect(source).toContain("MediaService.getVideosMap(mediaIds)");
        expect(source).toContain("covers: covers");
        expect(source).toContain("videos: videos");
        expect(source).toContain("cover_url: coverUrl");
    });

    test("MediaService.getCoversMap supports fallback to content image track", async () => {
        const source = await Bun.file(resolveSrc("src/features/media/queries.ts")).text();

        expect(source).toContain("eq(Track.purpose, TrackPurpose.COVER)");
        expect(source).toContain("eq(Track.purpose, TrackPurpose.CONTENT)");
        expect(source).toContain("eq(Track.type, TrackType.IMAGE)");
    });
});
