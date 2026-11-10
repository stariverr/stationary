import { describe, expect, test } from "bun:test";
import { DeleteStatus, File as DbFile, Media, MediaPreview, MediaType, PreviewSize } from "@/db/schema";
import { pickContentSource, planPreviews, previewSourceOf, previewsNeedWork, type PreviewState } from "@/features/media/preview";
import { detectFormatStrategy } from "@/lib/utils/preview_renderer";
import { PREVIEW_PROFILES, RECIPE_VERSION } from "@/lib/utils/preview_profiles";

type FileRow = typeof DbFile.$inferSelect;

const file = (id: string, extension = "jpg"): FileRow =>
    ({ id, path: `p/${id}.${extension}`, bucket: "b", extension, delete_status: DeleteStatus.ACTIVE }) as FileRow;

const content = (fileId: string, kind: "IMAGE" | "VIDEO", extension?: string) => ({ kind, file: file(fileId, extension) });

const preview = (size: PreviewSize, values: Partial<typeof MediaPreview.$inferSelect>) =>
    ({
        id: `p-${size}`,
        media_id: "m",
        size,
        source_file_id: "src",
        recipe_version: RECIPE_VERSION,
        file_id: `f-${size}`,
        width: 10,
        height: 10,
        last_error: null,
        ...values,
    }) as typeof MediaPreview.$inferSelect;

const state = (previews: (typeof MediaPreview.$inferSelect)[], activeFileIds = previews.flatMap((row) => (row.file_id ? [row.file_id] : []))): PreviewState => ({
    media: { id: "m", type: MediaType.IMAGE } as typeof Media.$inferSelect,
    source: { fileId: "src", path: "p/src.jpg", bucket: "b", renderAs: MediaType.IMAGE },
    previews,
    activePreviewFileIds: new Set(activeFileIds),
});

describe("preview profiles", () => {
    test("three sizes by longest edge", () => {
        expect(PREVIEW_PROFILES[PreviewSize.SMALL].maxEdge).toBe(360);
        expect(PREVIEW_PROFILES[PreviewSize.MEDIUM].maxEdge).toBe(720);
        expect(PREVIEW_PROFILES[PreviewSize.LARGE].maxEdge).toBe(1440);
    });
});

describe("preview source", () => {
    test("prefers a renderable image over a video frame", () => {
        expect(pickContentSource([content("video", "VIDEO"), content("image", "IMAGE")])).toMatchObject({ fileId: "image", renderAs: MediaType.IMAGE });
        expect(pickContentSource([content("jxl", "IMAGE", "jxl"), content("video", "VIDEO")])).toMatchObject({ fileId: "video", renderAs: MediaType.VIDEO });
        expect(pickContentSource([])).toBeNull();
    });

    test("a cover wins for video, audio and PDF; images never use one", () => {
        const cover = file("cover");
        const contents = [content("video", "VIDEO")];
        expect(previewSourceOf(MediaType.VIDEO, cover, contents)?.fileId).toBe("cover");
        expect(previewSourceOf(MediaType.AUDIO, cover, [])?.fileId).toBe("cover");
        expect(previewSourceOf(MediaType.IMAGE, cover, [content("image", "IMAGE")])?.fileId).toBe("image");
        expect(previewSourceOf(MediaType.VIDEO, null, contents)?.fileId).toBe("video");
    });

    test("audio and PDF without a cover have no preview", () => {
        expect(previewSourceOf(MediaType.AUDIO, null, [])).toBeNull();
        expect(previewSourceOf(MediaType.PDF, null, [])).toBeNull();
    });
});

describe("preview planning", () => {
    test("renders every size that is missing", () => {
        expect(planPreviews(state([]), true)).toEqual([PreviewSize.SMALL, PreviewSize.MEDIUM, PreviewSize.LARGE]);
    });

    test("a size made from the current source and recipe with its file is current", () => {
        const rows = [preview(PreviewSize.SMALL, {}), preview(PreviewSize.MEDIUM, {}), preview(PreviewSize.LARGE, {})];
        expect(planPreviews(state(rows), true)).toEqual([]);
        expect(previewsNeedWork(state(rows), true)).toBe(false);
    });

    test("another source, an older recipe or a deleted file renders the size again", () => {
        const rows = [
            preview(PreviewSize.SMALL, { source_file_id: "old" }),
            preview(PreviewSize.MEDIUM, { recipe_version: RECIPE_VERSION - 1 }),
            preview(PreviewSize.LARGE, {}),
        ];
        expect(planPreviews(state(rows, []), true)).toEqual([PreviewSize.SMALL, PreviewSize.MEDIUM, PreviewSize.LARGE]);
    });

    test("a failure on the current source is retried by a change but not by a scan", () => {
        const rows = [
            preview(PreviewSize.SMALL, { file_id: null, width: null, height: null, last_error: "boom" }),
            preview(PreviewSize.MEDIUM, {}),
            preview(PreviewSize.LARGE, {}),
        ];
        expect(planPreviews(state(rows), false)).toEqual([PreviewSize.SMALL]);
        expect(planPreviews(state(rows), true)).toEqual([]);
    });

    test("previews of a media without a source are removed", () => {
        const withoutSource = { ...state([preview(PreviewSize.SMALL, {})]), source: null };
        expect(planPreviews(withoutSource, false)).toEqual([]);
        expect(previewsNeedWork(withoutSource, true)).toBe(true);
    });
});

describe("format strategy", () => {
    test("classifies formats", () => {
        expect(detectFormatStrategy("https://example.com/photo.heic", MediaType.IMAGE)).toMatchObject({
            category: "HEIF_IMAGE",
            requiresLocalDownload: true,
        });
        expect(detectFormatStrategy("https://example.com/image.jpg", MediaType.IMAGE)).toMatchObject({
            category: "STANDARD_IMAGE",
            requiresLocalDownload: false,
        });
        expect(detectFormatStrategy("https://example.com/video.mp4", MediaType.VIDEO)).toMatchObject({
            category: "VIDEO_CONTAINER",
            seekOptions: ["-ss", "00:00:00.500"],
        });
    });
});
