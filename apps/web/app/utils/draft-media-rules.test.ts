import { describe, expect, test } from "bun:test";
import {
    getAllowedFileTrackTypes,
    getAllowedTrackPurposes,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    normalizeDraftTracksForMedia,
    type DraftTrackConfigBase,
} from "./draft-media-rules";
import { TrackType, TrackPurpose, MediaType } from "../types/post";

describe("draft media file classification", () => {
    const classificationCases: Array<[string, string, TrackType[]]> = [
        ["song.mp3", "application/octet-stream", [TrackType.AUDIO]],
        ["song.FLAC", "application/octet-stream", [TrackType.AUDIO]],
        ["song.ogg", "video/ogg", [TrackType.AUDIO]],
        ["clip.mov", "application/octet-stream", [TrackType.VIDEO]],
        ["clip.mp4", "video/mp4", [TrackType.VIDEO, TrackType.AUDIO]],
        ["segment.m4s", "video/iso.segment", [TrackType.VIDEO, TrackType.AUDIO]],
        ["cover.avif", "application/octet-stream", [TrackType.IMAGE]],
        ["cover.jxl", "application/octet-stream", [TrackType.IMAGE]],
        ["cover.jpeg", "application/octet-stream", [TrackType.IMAGE]],
        ["caption.vtt", "application/octet-stream", [TrackType.SUBTITLE]],
        ["caption.srt", "text/plain", [TrackType.SUBTITLE]],
        ["paper.pdf", "application/octet-stream", [TrackType.PDF]],
    ];

    test.each(classificationCases)("classifies %s", (name, mimeType, expected) => {
        expect(getAllowedFileTrackTypes(name, mimeType)).toEqual(expected);
    });

    test("does not silently treat an unknown file as an image", () => {
        expect(getAllowedFileTrackTypes("archive.bin", "application/octet-stream")).toEqual([]);
    });
});

describe("draft media composition rules", () => {
    test("only offers Video and Live Photo for a MOV plus JPEG", () => {
        expect(
            getCompatibleMediaTypes([
                { name: "IMG_9211.MOV", mime_type: "video/quicktime" },
                { name: "IMG_9211.jpeg", mime_type: "image/jpeg" },
            ]),
        ).toEqual([MediaType.VIDEO, MediaType.LIVE_PHOTO]);
    });

    test("offers Video or Audio for an ambiguous MP4", () => {
        expect(getCompatibleMediaTypes([{ name: "stream.mp4", mime_type: "video/mp4" }])).toEqual([MediaType.VIDEO, MediaType.AUDIO]);
    });

    test("keeps PDF as PDF", () => {
        expect(getCompatibleMediaTypes([{ name: "paper.pdf", mime_type: "application/pdf" }])).toEqual([MediaType.PDF]);
    });

    test("allows only images to serve as covers and thumbnails", () => {
        expect(getAllowedTrackPurposes(MediaType.VIDEO, TrackType.IMAGE)).toContain(TrackPurpose.COVER);
        expect(getAllowedTrackPurposes(MediaType.VIDEO, TrackType.VIDEO)).not.toContain(TrackPurpose.COVER);
        expect(getAllowedTrackPurposes(MediaType.VIDEO, TrackType.IMAGE)).toContain(TrackPurpose.THUMBNAIL);
        expect(getAllowedTrackPurposes(MediaType.VIDEO, TrackType.VIDEO)).not.toContain(TrackPurpose.THUMBNAIL);
        expect(getAllowedTrackPurposes(MediaType.AUDIO, TrackType.AUDIO)).not.toContain(TrackPurpose.THUMBNAIL);
    });

    test("normalizes a MOV plus JPEG into a valid video composition", () => {
        const tracks: DraftTrackConfigBase[] = [
            { name: "IMG_9211.MOV", mime_type: "video/quicktime", type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, is_default: false },
            { name: "IMG_9211.jpeg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, is_default: false },
        ];

        const normalized = normalizeDraftTracksForMedia(MediaType.VIDEO, tracks);
        expect(normalized[0]).toMatchObject({ type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, is_default: true });
        expect(normalized[1]).toMatchObject({ type: TrackType.IMAGE, purpose: TrackPurpose.COVER, is_default: false });
        expect(getDraftCompositionError(MediaType.VIDEO, normalized)).toBeNull();
    });

    test("lets only video, audio and PDF media take a cover", () => {
        for (const mediaType of [MediaType.VIDEO, MediaType.AUDIO, MediaType.PDF]) {
            expect(getAllowedTrackPurposes(mediaType, TrackType.IMAGE)).toContain(TrackPurpose.COVER);
        }
        for (const mediaType of [MediaType.IMAGE, MediaType.LIVE_PHOTO]) {
            expect(getAllowedTrackPurposes(mediaType, TrackType.IMAGE)).not.toContain(TrackPurpose.COVER);
        }
    });

    test("gives the cover to one image and makes the next a thumbnail", () => {
        const tracks: DraftTrackConfigBase[] = [
            { name: "song.mp3", mime_type: "audio/mpeg", type: TrackType.AUDIO, purpose: TrackPurpose.CONTENT, is_default: false },
            { name: "front.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, is_default: false },
            { name: "back.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, is_default: false },
        ];

        const normalized = normalizeDraftTracksForMedia(MediaType.AUDIO, tracks);
        expect(normalized[1]).toMatchObject({ purpose: TrackPurpose.COVER });
        expect(normalized[2]).toMatchObject({ purpose: TrackPurpose.THUMBNAIL });
        expect(getDraftCompositionError(MediaType.AUDIO, normalized)).toBeNull();
    });

    test("rejects more than one cover", () => {
        const tracks: DraftTrackConfigBase[] = [
            { name: "clip.mov", mime_type: "video/quicktime", type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, is_default: true },
            { name: "a.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.COVER, is_default: false },
            { name: "b.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.COVER, is_default: false },
        ];

        expect(getDraftCompositionError(MediaType.VIDEO, tracks)).toEqual({ key: "media.errors.only_one_cover_allowed" });
    });

    test("rejects a cover on image media", () => {
        const tracks: DraftTrackConfigBase[] = [
            { name: "photo.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, is_default: true },
            { name: "cover.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.COVER, is_default: false },
        ];

        expect(getDraftCompositionError(MediaType.IMAGE, tracks)?.key).toBe("media.errors.cannot_use_purpose_in_media");
    });

    test("requires distinct default image and video tracks for a Live Photo", () => {
        const tracks: DraftTrackConfigBase[] = [
            { name: "still.jpg", mime_type: "image/jpeg", type: TrackType.IMAGE, purpose: TrackPurpose.COVER, is_default: false },
            { name: "motion.mov", mime_type: "video/quicktime", type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, is_default: false },
        ];

        const normalized = normalizeDraftTracksForMedia(MediaType.LIVE_PHOTO, tracks);
        expect(normalized).toEqual([
            expect.objectContaining({ type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, is_default: true }),
            expect.objectContaining({ type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, is_default: true }),
        ]);
        expect(getDraftCompositionError(MediaType.LIVE_PHOTO, normalized)).toBeNull();
    });
});
