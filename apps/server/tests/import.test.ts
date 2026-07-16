import { describe, expect, test } from "bun:test";
import { DraftFileStatus, MediaType, TrackPurpose, TrackType, DeleteStatus } from "../src/db/schema";
import {
    assignTrackPriorities,
    validateDraftMediaGroups,
    validateDraftTrackFileTypes,
    validateMediaComposition,
    type MediaCompositionTrack,
} from "../src/lib/validation/media-composition";
import { consumeDraftFile, deleteDraftFile, DraftFileUnavailableError } from "../src/services/draft-file";
import { getAllowedTrackTypesForFile, getMimeTypeByExt } from "../src/lib/utils/file";

const primaryTrack = (type: TrackType): MediaCompositionTrack => ({
    type,
    purpose: TrackPurpose.CONTENT,
    is_default: true,
});

describe("manual media composition", () => {
    test.each([
        [MediaType.IMAGE, TrackType.IMAGE],
        [MediaType.VIDEO, TrackType.VIDEO],
        [MediaType.AUDIO, TrackType.AUDIO],
        [MediaType.PDF, TrackType.PDF],
    ])("accepts a %s media with its default content track", (mediaType, trackType) => {
        expect(validateMediaComposition(mediaType, [primaryTrack(trackType)])).toBeNull();
    });

    test("rejects a subtitle as standalone media", () => {
        const error = validateMediaComposition(MediaType.IMAGE, [primaryTrack(TrackType.SUBTITLE)]);
        expect(error).toContain("SUBTITLE CONTENT tracks are not valid for IMAGE media");
    });

    test("requires both image and video defaults for Live Photos", () => {
        expect(validateMediaComposition(MediaType.LIVE_PHOTO, [primaryTrack(TrackType.IMAGE)])).toContain("default VIDEO CONTENT track");
        expect(validateMediaComposition(MediaType.LIVE_PHOTO, [primaryTrack(TrackType.IMAGE), primaryTrack(TrackType.VIDEO)])).toBeNull();
    });

    test("accepts video, audio, and subtitle content in one video media", () => {
        expect(
            validateMediaComposition(MediaType.VIDEO, [
                primaryTrack(TrackType.VIDEO),
                primaryTrack(TrackType.AUDIO),
                primaryTrack(TrackType.SUBTITLE),
            ]),
        ).toBeNull();
    });

    test("rejects multiple defaults in the same track group", () => {
        expect(validateMediaComposition(MediaType.VIDEO, [primaryTrack(TrackType.VIDEO), primaryTrack(TrackType.VIDEO)])).toContain(
            "Only one default VIDEO CONTENT track",
        );
    });

    test.each([TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE, TrackType.PDF])(
        "rejects a %s cover because covers must be images",
        (type) => {
            expect(
                validateMediaComposition(MediaType.VIDEO, [
                    primaryTrack(TrackType.VIDEO),
                    { type, purpose: TrackPurpose.COVER, is_default: false },
                ]),
            ).toContain("COVER tracks must use the IMAGE type");
        },
    );

    test("rejects PDF tracks outside the content purpose", () => {
        expect(
            validateMediaComposition(MediaType.PDF, [{ type: TrackType.PDF, purpose: TrackPurpose.PREVIEW, is_default: true }]),
        ).toContain("PDF tracks must use the CONTENT purpose");
    });

    test("rejects reuse of one draft file across media groups", () => {
        const groups = [MediaType.IMAGE, MediaType.IMAGE].map((type, index) => ({
            temp_id: `media-${index}`,
            type,
            tracks: [
                {
                    draft_file_id: "01900000-0000-7000-8000-000000000001",
                    ...primaryTrack(TrackType.IMAGE),
                },
            ],
        }));

        expect(validateDraftMediaGroups(groups)).toContain("cannot be used more than once");
    });

    test("assigns independent priorities per track group and continues existing groups", () => {
        const tracks = assignTrackPriorities(
            [
                { type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT },
                { type: TrackType.AUDIO, purpose: TrackPurpose.CONTENT },
                { type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT },
            ],
            [{ type: TrackType.VIDEO, purpose: TrackPurpose.CONTENT, priority: 2 }],
        );

        expect(tracks.map((track) => track.priority)).toEqual([3, 0, 4]);
    });
});

describe("draft file type constraints", () => {
    test.each([
        ["track.mp3", "application/octet-stream", [TrackType.AUDIO]],
        ["track.FLAC", "application/octet-stream", [TrackType.AUDIO]],
        ["track.ogg", "video/ogg", [TrackType.AUDIO]],
        ["clip.mov", "application/octet-stream", [TrackType.VIDEO]],
        ["clip.mp4", "video/mp4", [TrackType.VIDEO, TrackType.AUDIO]],
        ["segment.m4s", "video/iso.segment", [TrackType.VIDEO, TrackType.AUDIO]],
        ["cover.avif", "application/octet-stream", [TrackType.IMAGE]],
        ["cover.jxl", "application/octet-stream", [TrackType.IMAGE]],
        ["subtitle.srt", "text/plain", [TrackType.SUBTITLE]],
        ["document.pdf", "application/octet-stream", [TrackType.PDF]],
    ])("classifies %s from its extension", (name, mimeType, expected) => {
        expect(getAllowedTrackTypesForFile(name, mimeType)).toEqual(expected);
    });

    test.each([
        ["flac", "audio/flac"],
        ["ogg", "audio/ogg"],
        ["m4s", "video/iso.segment"],
        ["srt", "application/x-subrip"],
        ["pdf", "application/pdf"],
    ])("maps .%s to %s", (extension, expectedMimeType) => {
        expect(getMimeTypeByExt(extension)).toBe(expectedMimeType);
    });

    test("rejects a declared track type that does not match the draft file", () => {
        const draftFileId = "01900000-0000-7000-8000-000000000001";
        const groups = [
            {
                type: MediaType.IMAGE,
                tracks: [
                    {
                        draft_file_id: draftFileId,
                        type: TrackType.IMAGE,
                        purpose: TrackPurpose.CONTENT,
                        is_default: true,
                    },
                ],
            },
        ];
        const files = new Map([[draftFileId, { name: "song.mp3", mime_type: "audio/mpeg" }]]);

        expect(validateDraftTrackFileTypes(groups, files)).toContain("song.mp3 can only be used as AUDIO track");
    });

    test.each([TrackType.VIDEO, TrackType.AUDIO])("accepts an MP4 declared as %s", (type) => {
        const draftFileId = "01900000-0000-7000-8000-000000000001";
        const groups = [
            {
                type: type === TrackType.VIDEO ? MediaType.VIDEO : MediaType.AUDIO,
                tracks: [
                    {
                        draft_file_id: draftFileId,
                        type,
                        purpose: TrackPurpose.CONTENT,
                        is_default: true,
                    },
                ],
            },
        ];
        const files = new Map([[draftFileId, { name: "stream.mp4", mime_type: "video/mp4" }]]);

        expect(validateDraftTrackFileTypes(groups, files)).toBeNull();
    });
});

function createFakeTransaction(returningRows: Array<Array<{ file_id: string }>>) {
    const updates: Array<Record<string, unknown>> = [];
    const deletes: unknown[] = [];
    const tx = {
        update() {
            return {
                set(values: Record<string, unknown>) {
                    updates.push(values);
                    return {
                        where() {
                            return {
                                returning: async () => returningRows.shift() ?? [],
                            };
                        },
                    };
                },
            };
        },
        delete(table: unknown) {
            deletes.push(table);
            return {
                where() {
                    return {
                        returning: async () => returningRows.shift() ?? [],
                    };
                },
            };
        },
    };

    return { tx, updates, deletes };
}

describe("draft file atomic transitions", () => {
    const draftId = "01900000-0000-7000-8000-000000000001";
    const fileId = "01900000-0000-7000-8000-000000000002";
    const libraryId = "01900000-0000-7000-8000-000000000003";

    test("removes a draft and returns its physical file identity", async () => {
        const { tx, deletes } = createFakeTransaction([[{ file_id: fileId }]]);

        await expect(consumeDraftFile(tx as never, draftId, libraryId)).resolves.toBe(fileId);
        expect(deletes).toHaveLength(1);
    });

    test("reports a conflict when another request already consumed the draft", async () => {
        const { tx } = createFakeTransaction([[]]);

        await expect(consumeDraftFile(tx as never, draftId, libraryId)).rejects.toBeInstanceOf(DraftFileUnavailableError);
    });

    test("deletes the DraftFile and physical File in one transaction", async () => {
        const { tx, updates } = createFakeTransaction([[{ file_id: fileId }]]);

        await expect(deleteDraftFile(tx as never, draftId, libraryId)).resolves.toBe(true);
        expect(updates[0]?.status).toBe(DraftFileStatus.DELETED);
        expect(updates[1]?.delete_status).toBe(DeleteStatus.DELETED);
    });

    test("does not delete the physical File after losing the draft transition race", async () => {
        const { tx, updates } = createFakeTransaction([[]]);

        await expect(deleteDraftFile(tx as never, draftId, libraryId)).resolves.toBe(false);
        expect(updates).toHaveLength(1);
    });
});
