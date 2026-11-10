import { describe, expect, test } from "bun:test";
import {
    buildMediaDraft,
    DraftFileRole,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    getDraftFileRole,
    getFileCategories,
    guessMediaType,
    toDraftFileConfig,
} from "./draft-media-rules";
import { FileCategory, MediaType } from "../types/post";

const file = (name: string, mime_type = "application/octet-stream") => ({ name, mime_type });

describe("draft media file classification", () => {
    const classificationCases: Array<[string, string, FileCategory[]]> = [
        ["song.mp3", "application/octet-stream", [FileCategory.AUDIO]],
        ["song.FLAC", "application/octet-stream", [FileCategory.AUDIO]],
        ["song.ogg", "video/ogg", [FileCategory.AUDIO]],
        ["clip.mov", "application/octet-stream", [FileCategory.VIDEO]],
        ["clip.mp4", "video/mp4", [FileCategory.VIDEO, FileCategory.AUDIO]],
        ["segment.m4s", "video/iso.segment", [FileCategory.VIDEO, FileCategory.AUDIO]],
        ["cover.avif", "application/octet-stream", [FileCategory.IMAGE]],
        ["cover.jxl", "application/octet-stream", [FileCategory.IMAGE]],
        ["cover.jpeg", "application/octet-stream", [FileCategory.IMAGE]],
        ["caption.vtt", "application/octet-stream", [FileCategory.SUBTITLE]],
        ["caption.srt", "text/plain", [FileCategory.SUBTITLE]],
        ["paper.pdf", "application/octet-stream", [FileCategory.PDF]],
    ];

    test.each(classificationCases)("classifies %s", (name, mimeType, expected) => {
        expect(getFileCategories(name, mimeType)).toEqual(expected);
    });

    test("does not silently treat an unknown file as an image", () => {
        expect(getFileCategories("archive.bin", "application/octet-stream")).toEqual([]);
    });
});

describe("draft file roles", () => {
    test("makes an image the cover of video, audio and PDF media and an original of image media", () => {
        for (const mediaType of [MediaType.VIDEO, MediaType.AUDIO, MediaType.PDF]) {
            expect(getDraftFileRole(mediaType, file("a.jpg"))).toBe(DraftFileRole.COVER);
        }
        for (const mediaType of [MediaType.IMAGE, MediaType.LIVE_PHOTO]) {
            expect(getDraftFileRole(mediaType, file("a.jpg"))).toBe(DraftFileRole.ORIGINAL);
        }
    });

    test("allows captions only on video and audio media", () => {
        expect(getDraftFileRole(MediaType.VIDEO, file("a.srt"))).toBe(DraftFileRole.CAPTION);
        expect(getDraftFileRole(MediaType.AUDIO, file("a.vtt"))).toBe(DraftFileRole.CAPTION);
        expect(getDraftFileRole(MediaType.IMAGE, file("a.vtt"))).toBeNull();
        expect(getDraftFileRole(MediaType.PDF, file("a.vtt"))).toBeNull();
    });
});

describe("draft media composition rules", () => {
    test("offers Video, Live Photo and Audio for a MOV plus JPEG, guessing Video", () => {
        // Like the server, a video container may hold an audio-only original; probing decides.
        const files = [file("IMG_9211.MOV", "video/quicktime"), file("IMG_9211.jpeg", "image/jpeg")];
        expect(getCompatibleMediaTypes(files)).toEqual([MediaType.VIDEO, MediaType.LIVE_PHOTO, MediaType.AUDIO]);
        expect(guessMediaType(files)).toBe(MediaType.VIDEO);
    });

    test("offers Video or Audio for an ambiguous MP4", () => {
        expect(getCompatibleMediaTypes([file("stream.mp4", "video/mp4")])).toEqual([MediaType.VIDEO, MediaType.AUDIO]);
        expect(guessMediaType([file("stream.mp4", "video/mp4")])).toBe(MediaType.VIDEO);
    });

    test("keeps PDF as PDF", () => {
        expect(getCompatibleMediaTypes([file("paper.pdf", "application/pdf")])).toEqual([MediaType.PDF]);
    });

    test("lets a video take separate audio files but only one video-only file", () => {
        expect(getDraftCompositionError(MediaType.VIDEO, [file("v.mp4"), file("en.m4a"), file("ja.m4a")])).toBeNull();
        expect(getDraftCompositionError(MediaType.VIDEO, [file("v.mp4"), file("a.mp4")])).toBeNull();
        expect(getDraftCompositionError(MediaType.VIDEO, [file("a.mov"), file("b.mkv")])?.key).toBe("media.errors.originals_video");
        expect(getDraftCompositionError(MediaType.VIDEO, [file("a.m4a")])?.key).toBe("media.errors.originals_video");
    });

    test("takes exactly one original for audio, image and PDF media", () => {
        expect(getDraftCompositionError(MediaType.AUDIO, [file("a.mp3"), file("b.mp3")])?.key).toBe("media.errors.originals_audio");
        expect(getDraftCompositionError(MediaType.IMAGE, [file("a.jpg"), file("b.jpg")])?.key).toBe("media.errors.originals_image");
        expect(getDraftCompositionError(MediaType.AUDIO, [file("a.mp3"), file("cover.jpg"), file("lyrics.srt")])).toBeNull();
    });

    test("needs an image and a video for a Live Photo", () => {
        expect(getDraftCompositionError(MediaType.LIVE_PHOTO, [file("still.jpg"), file("motion.mov")])).toBeNull();
        expect(getDraftCompositionError(MediaType.LIVE_PHOTO, [file("still.jpg")])?.key).toBe("media.errors.originals_live_photo");
    });

    test("rejects more than one cover", () => {
        expect(getDraftCompositionError(MediaType.VIDEO, [file("clip.mov"), file("a.jpg"), file("b.jpg")])).toEqual({
            key: "media.errors.only_one_cover_allowed",
        });
    });

    test("rejects more than one default caption", () => {
        const captions = [
            { ...file("en.srt"), is_default: true },
            { ...file("ja.srt"), is_default: true },
        ];
        expect(getDraftCompositionError(MediaType.VIDEO, [file("clip.mov"), ...captions])?.key).toBe(
            "media.errors.only_one_default_caption",
        );
    });

    test("rejects a file that fits no role", () => {
        expect(getDraftCompositionError(MediaType.PDF, [file("paper.pdf"), file("notes.srt")])?.key).toBe("media.errors.file_not_allowed");
    });
});

describe("media draft payload", () => {
    test("splits files into originals, cover and captions", () => {
        const files = [
            toDraftFileConfig({ id: "v", name: "clip.mp4", mime_type: "video/mp4" }),
            toDraftFileConfig({ id: "a", name: "commentary.m4a", mime_type: "audio/mp4" }),
            toDraftFileConfig({ id: "c", name: "poster.jpg", mime_type: "image/jpeg" }),
            { ...toDraftFileConfig({ id: "s", name: "en.srt", mime_type: "text/plain" }), language: " en ", is_default: true },
        ];
        expect(buildMediaDraft("Clip", MediaType.VIDEO, files)).toEqual({
            title: "Clip",
            type: MediaType.VIDEO,
            originals: ["v", "a"],
            cover: "c",
            captions: [{ draft_file_id: "s", language: "en", label: null, is_default: true }],
        });
    });
});
