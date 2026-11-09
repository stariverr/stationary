import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

describe("media list query", () => {
    test("loads previews, content URLs and videos in parallel", async () => {
        const source = await Bun.file(resolveSrc("src/api/media.ts")).text();

        expect(source).toContain("loadPreviewImages(mediaIds)");
        expect(source).toContain("MediaService.getContentUrls(mediaIds)");
        expect(source).toContain("MediaService.getVideosMap(mediaIds)");
        expect(source).toContain("previews: previewsByMediaId.get(m.id) ?? NO_PREVIEWS");
        expect(source).not.toContain("cover_url");
    });
});
