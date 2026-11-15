import { describe, expect, test } from "bun:test";
import { DeleteStatus, File as DbFile, Media, MediaPreview, MediaType, PreviewSize } from "@/db/schema";
import { pickContentSource, planPreviews, previewSourceOf, previewsNeedWork, type PreviewState } from "@/features/media/preview";
import { detectFormatStrategy } from "@/lib/utils/preview_renderer";
import { PREVIEW_PROFILES, RECIPE_VERSION } from "@/lib/utils/preview_profiles";
import { readVvic } from "@/lib/utils/vvic";

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
        expect(pickContentSource([content("video", "VIDEO"), content("vvic", "IMAGE", "vvic")])).toMatchObject({ fileId: "vvic", renderAs: MediaType.IMAGE });
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
        expect(detectFormatStrategy("https://example.com/photo.vvic", MediaType.IMAGE)).toMatchObject({
            category: "VVIC_IMAGE",
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

describe("vvic", () => {
    const bytes = (...parts: (number | number[] | Uint8Array | string)[]) =>
        Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : typeof part === "number" ? [part] : [...part])));
    const u16 = (value: number) => [value >> 8, value & 255];
    const u32 = (value: number) => [0, 0, ...u16(value)];
    const box = (type: string, ...parts: (number | number[] | Uint8Array | string)[]) => {
        const payload = bytes(...parts);
        return bytes(u32(payload.length + 8), type, payload);
    };

    const SPS = [0x00, 0x79, 0xaa];
    const PPS = [0x00, 0x81, 0xbb];
    const PICTURE = [0x00, 0x39, 0xcc, 0xdd];
    // Douyin's vvcC: no version and flags, a draft profile-tier-level record, then the parameter set arrays.
    const vvcC = box("vvcC", [0xff, 0x00, 0x11, 0x1f, 0x04, 0x09, 0xa4, 0x00, 0x00], u16(1440), u16(1920), u16(0), 2, [0x0f, ...u16(1), ...u16(3), ...SPS], [0x10, ...u16(1), ...u16(3), ...PPS]);

    const vvic = (itemType = "vvc1", properties: Uint8Array[] = []) => {
        const meta = (pictureOffset: number) =>
            box(
                "meta",
                u32(0),
                box("pitm", u32(0), u16(1)),
                box("iinf", u32(0), u16(1), box("infe", [2, 0, 0, 0], u16(1), u16(0), itemType, 0)),
                box(
                    "iprp",
                    box("ipco", vvcC, box("ispe", u32(0), u32(1440), u32(1920)), ...properties),
                    box("ipma", u32(0), u32(1), u16(1), 2 + properties.length, 0x81, 2, properties.map((_, index) => 3 + index)),
                ),
                box("iloc", u32(0), [0x44, 0x00], u16(1), u16(1), u16(0), u16(1), u32(pictureOffset), u32(PICTURE.length + 4)),
            );
        const ftyp = box("ftyp", "vvic", u32(0), "mif1vvic");
        return bytes(ftyp, meta(ftyp.length + meta(0).length + 8), box("mdat", u32(PICTURE.length), PICTURE));
    };

    test("reads the size and the picture as an Annex B stream", () => {
        expect(readVvic(vvic())).toEqual({
            width: 1440,
            height: 1920,
            annexB: Uint8Array.from([0, 0, 0, 1, ...SPS, 0, 0, 0, 1, ...PPS, 0, 0, 0, 1, ...PICTURE]),
        });
    });

    test("rejects a tiled image and a transformed picture", () => {
        expect(() => readVvic(vvic("grid"))).toThrow("grid");
        expect(() => readVvic(vvic("vvc1", [box("irot", 1)]))).toThrow("irot");
    });
});
