import { describe, expect, test } from "bun:test";
import { DraftFileStatus, MediaType, DeleteStatus } from "../src/db/schema";
import { draftStructureError, validateDraftMediaGroups, type MediaDraft } from "../src/lib/validation/media-composition";
import { compositionError, originalCountError } from "../src/features/media/originals";
import { consumeDraftFile, deleteDraftFile, DraftFileUnavailableError } from "../src/features/import/draft-file";
import { getFileCategories, getMimeTypeByExt, type FileCategory } from "../src/lib/utils/file";

describe("media composition (section 4)", () => {
    test.each([
        [MediaType.IMAGE, ["IMAGE"]],
        [MediaType.PDF, ["PDF"]],
        [MediaType.AUDIO, ["AUDIO"]],
        [MediaType.VIDEO, ["VIDEO"]],
        [MediaType.VIDEO, ["VIDEO", "AUDIO", "AUDIO"]],
        [MediaType.LIVE_PHOTO, ["IMAGE", "VIDEO"]],
    ] as const)("accepts %s made of %p", (type, kinds) => {
        expect(compositionError(type, [...kinds])).toBeNull();
    });

    test.each([
        [MediaType.VIDEO, ["AUDIO"]],
        [MediaType.VIDEO, ["VIDEO", "VIDEO"]],
        [MediaType.AUDIO, ["VIDEO"]],
        [MediaType.AUDIO, ["AUDIO", "AUDIO"]],
        [MediaType.LIVE_PHOTO, ["IMAGE"]],
        [MediaType.IMAGE, ["IMAGE", "IMAGE"]],
        [MediaType.PDF, ["IMAGE"]],
    ] as const)("rejects %s made of %p", (type, kinds) => {
        expect(compositionError(type, [...kinds])).not.toBeNull();
    });

    test("counts originals before they are probed", () => {
        expect(originalCountError(MediaType.VIDEO, 3)).toBeNull();
        expect(originalCountError(MediaType.LIVE_PHOTO, 1)).not.toBeNull();
        expect(originalCountError(MediaType.IMAGE, 2)).not.toBeNull();
    });
});

describe("media drafts", () => {
    const ids = {
        video: "01900000-0000-7000-8000-000000000001",
        audio: "01900000-0000-7000-8000-000000000002",
        cover: "01900000-0000-7000-8000-000000000003",
        caption: "01900000-0000-7000-8000-000000000004",
        caption2: "01900000-0000-7000-8000-000000000005",
    };
    const names: Record<string, string> = {
        [ids.video]: "clip.mp4",
        [ids.audio]: "dub.m4a",
        [ids.cover]: "cover.jpg",
        [ids.caption]: "en.srt",
        [ids.caption2]: "ja.ass",
    };
    const fileName = (id: string) => names[id];
    const draft = (values: Partial<MediaDraft>): MediaDraft => ({
        title: "",
        description: "",
        type: MediaType.VIDEO,
        tag_ids: [],
        originals: [ids.video],
        cover: null,
        captions: [],
        ...values,
    });

    test("accepts a video with separate audio, a cover and captions", () => {
        const value = draft({
            originals: [ids.video, ids.audio],
            cover: ids.cover,
            captions: [
                { draft_file_id: ids.caption, is_default: true },
                { draft_file_id: ids.caption2, is_default: false },
            ],
        });
        expect(draftStructureError(value, fileName)).toBeNull();
    });

    test("rejects files that cannot be what the draft uses them as", () => {
        expect(draftStructureError(draft({ originals: [ids.caption] }), fileName)).toContain("cannot be an original");
        expect(draftStructureError(draft({ cover: ids.video }), fileName)).toBe("A cover must be an image");
        expect(draftStructureError(draft({ type: MediaType.IMAGE, originals: [ids.cover], cover: ids.cover }), fileName)).toContain(
            "cannot have a cover",
        );
        expect(draftStructureError(draft({ captions: [{ draft_file_id: ids.cover, is_default: false }] }), fileName)).toContain(
            "is not a caption file",
        );
    });

    test("allows one default caption", () => {
        const captions = [
            { draft_file_id: ids.caption, is_default: true },
            { draft_file_id: ids.caption2, is_default: true },
        ];
        expect(draftStructureError(draft({ captions }), fileName)).toBe("Only one caption can be the default");
    });

    test("rejects reuse of one draft file across media", () => {
        expect(validateDraftMediaGroups([draft({}), draft({})], fileName)).toContain("is used more than once");
    });
});

describe("draft file types", () => {
    test.each([
        ["track.mp3", "application/octet-stream", ["AUDIO"]],
        ["track.FLAC", "application/octet-stream", ["AUDIO"]],
        ["track.ogg", "video/ogg", ["AUDIO"]],
        ["clip.mov", "application/octet-stream", ["VIDEO"]],
        ["clip.mp4", "video/mp4", ["VIDEO", "AUDIO"]],
        ["segment.m4s", "video/iso.segment", ["VIDEO", "AUDIO"]],
        ["cover.avif", "application/octet-stream", ["IMAGE"]],
        ["cover.jxl", "application/octet-stream", ["IMAGE"]],
        ["subtitle.srt", "text/plain", ["SUBTITLE"]],
        ["document.pdf", "application/octet-stream", ["PDF"]],
    ] as [string, string, FileCategory[]][])("classifies %s from its extension", (name, mimeType, expected) => {
        expect(getFileCategories(name, mimeType)).toEqual(expected);
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
        const { tx, updates } = createFakeTransaction([[{ file_id: fileId }]]);

        await expect(consumeDraftFile(tx as never, draftId, libraryId)).resolves.toBe(fileId);
        expect(updates).toHaveLength(1);
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
