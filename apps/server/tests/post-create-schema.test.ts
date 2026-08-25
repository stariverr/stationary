import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { MediaType, TrackPurpose, TrackType } from "../src/db/schema";
import { Quality } from "../src/lib/types";
import { CreatePostSchema } from "../src/features/post/schema";

const libraryId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
const mediaId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b4";
const draftFileId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b5";

describe("create post schema", () => {
    test("applies defaults for optional fields", () => {
        const parsed = v.parse(CreatePostSchema, {
            library_id: libraryId,
            title: "A new post",
        });

        expect(parsed).toEqual({
            library_id: libraryId,
            title: "A new post",
            description: "",
            tag_ids: [],
        });
    });

    test("accepts existing media items", () => {
        const parsed = v.safeParse(CreatePostSchema, {
            library_id: libraryId,
            title: "Existing media",
            media_items: [{ kind: "existing", media_id: mediaId }],
        });

        expect(parsed.success).toBe(true);
    });

    test("accepts draft media items with track metadata", () => {
        const parsed = v.safeParse(CreatePostSchema, {
            library_id: libraryId,
            title: "Draft media",
            media_items: [
                {
                    kind: "draft",
                    draft: {
                        type: MediaType.AUDIO,
                        tag_ids: [],
                        tracks: [
                            {
                                draft_file_id: draftFileId,
                                type: TrackType.AUDIO,
                                purpose: TrackPurpose.CONTENT,
                                quality: Quality.HIGH,
                                is_default: true,
                            },
                        ],
                    },
                },
            ],
        });

        expect(parsed.success).toBe(true);
    });

    test("rejects invalid media item discriminators and nested ids", () => {
        const parsed = v.safeParse(CreatePostSchema, {
            library_id: libraryId,
            title: "Invalid media",
            media_items: [
                { kind: "existing", media_id: "not-a-uuid" },
                { kind: "unknown", media_id: mediaId },
            ],
        });

        expect(parsed.success).toBe(false);
    });

    test("rejects blank titles", () => {
        const parsed = v.safeParse(CreatePostSchema, {
            library_id: libraryId,
            title: "",
        });

        expect(parsed.success).toBe(false);
    });
});
