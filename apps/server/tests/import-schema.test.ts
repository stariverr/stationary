import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { MediaType } from "../src/db/schema";
import { ConfirmDraftSchema, CommitMediaSchema, PresignDraftSchema } from "../src/features/import/schema";

const libraryId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
const draftFileId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";

describe("draft import schemas", () => {
    test("accepts a presign request", () => {
        const parsed = v.safeParse(PresignDraftSchema, {
            library_id: libraryId,
            fileName: "cover.jpg",
        });

        expect(parsed.success).toBe(true);
    });

    test("requires all upload confirmation fields", () => {
        const parsed = v.safeParse(ConfirmDraftSchema, {
            library_id: libraryId,
            draft_file_id: draftFileId,
            fileName: "cover.jpg",
        });

        expect(parsed.success).toBe(false);
    });

    test("normalizes optional media draft fields", () => {
        const parsed = v.parse(CommitMediaSchema, {
            library_id: libraryId,
            media_drafts: [
                {
                    type: MediaType.VIDEO,
                    originals: [draftFileId],
                    captions: [{ draft_file_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5" }],
                },
            ],
        });

        expect(parsed.media_drafts[0]).toMatchObject({
            title: "",
            description: "",
            tag_ids: [],
            cover: null,
        });
        expect(parsed.media_drafts[0].captions[0].is_default).toBe(false);
    });

    test("requires at least one original", () => {
        const parsed = v.safeParse(CommitMediaSchema, {
            library_id: libraryId,
            media_drafts: [{ type: MediaType.IMAGE, originals: [] }],
        });

        expect(parsed.success).toBe(false);
    });

    test("rejects an empty media commit", () => {
        const parsed = v.safeParse(CommitMediaSchema, {
            library_id: libraryId,
            media_drafts: [],
        });

        expect(parsed.success).toBe(false);
    });
});
