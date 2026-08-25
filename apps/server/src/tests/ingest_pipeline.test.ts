import { describe, expect, test } from "bun:test";
import { AsyncSubjectType, AsyncTaskUnitKind } from "@/db/schema";
import { buildPostProcessUnitSpecs } from "@/features/ingest/post-process-units";

describe("post-process unit construction", () => {
    test("uses media IDs as media download subjects", () => {
        const units = buildPostProcessUnitSpecs({
            postId: "post-1",
            mediaIds: ["media-1", "media-2"],
            authorId: null,
        });

        expect(units).toEqual([
            {
                unitKey: "media:media-1",
                kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                subjectType: AsyncSubjectType.MEDIA,
                subjectId: "media-1",
                inputSnapshot: { post_id: "post-1", media_id: "media-1" },
            },
            {
                unitKey: "media:media-2",
                kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                subjectType: AsyncSubjectType.MEDIA,
                subjectId: "media-2",
                inputSnapshot: { post_id: "post-1", media_id: "media-2" },
            },
        ]);
    });

    test("adds an avatar unit only when an avatar URL is available", () => {
        const units = buildPostProcessUnitSpecs({
            postId: "post-1",
            mediaIds: [],
            authorId: "author-1",
            avatarUrl: "https://example.test/avatar.jpg",
        });

        expect(units).toEqual([
            {
                unitKey: "avatar:author-1",
                kind: AsyncTaskUnitKind.AVATAR_DOWNLOAD,
                subjectType: AsyncSubjectType.AUTHOR,
                subjectId: "author-1",
                inputSnapshot: {
                    author_id: "author-1",
                    avatar_url: "https://example.test/avatar.jpg",
                },
            },
        ]);
    });
});
