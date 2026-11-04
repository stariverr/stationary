import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";

import { aiRouter } from "@/api/ai";
import importRouter from "@/api/import";
import mediaRouter from "@/api/media";
import postRouter from "@/api/post";
import searchRouter from "@/api/search";
import tagRouter from "@/api/tag";
import taskRouter from "@/api/task";
import trashRouter from "@/api/trash";
import {
    DeleteStatus,
    DraftFile,
    ExternalApiToken,
    File as DbFile,
    JobQueue,
    Library,
    Media,
    MediaType,
    Post,
    SyncStatus,
    Tag,
    TagSource,
    TagStatus,
    TrackPurpose,
    TrackType,
    User,
} from "@/db/schema";
import { ApiTokenService } from "@/features/auth/api-token";
import { db } from "@/global/db";
import { Quality } from "@/lib/types";

type Route = [router: Hono<any>, path: string, method?: string, body?: unknown];

/**
 * Drives the content routes through real API tokens against a real PostgreSQL.
 * Run with RUN_CONTENT_DB_TESTS=1 and DB_URL pointing at a disposable instance.
 */
describe.skipIf(process.env.RUN_CONTENT_DB_TESTS !== "1")("Content access control", () => {
    const libraryIds: string[] = [];
    const userIds: string[] = [];
    const fileIds: string[] = [];

    let aliceToken: string;
    let aliceScopedToken: string;
    let aliceLibrary: string;
    let aliceOtherLibrary: string;
    let aliceDeletedLibrary: string;
    let bobLibrary: string;
    let alicePost: string;
    let aliceMedia: string;
    let aliceTag: string;
    let bobPost: string;
    let bobMedia: string;
    let bobTag: string;
    let bobDraft: string;
    let otherLibraryPost: string;
    let otherLibraryMedia: string;

    const createUser = async (name: string) => {
        const [user] = await db.insert(User).values({ auth_id: crypto.randomUUID(), name }).returning();
        userIds.push(user.id);
        return user.id;
    };

    const createLibrary = async (ownerId: string, name: string, deleted = false) => {
        const [library] = await db
            .insert(Library)
            .values({ name, description: "", owner_id: ownerId, delete_status: deleted ? DeleteStatus.DELETED : DeleteStatus.ACTIVE })
            .returning();
        libraryIds.push(library.id);
        return library.id;
    };

    const createPost = async (libraryId: string, title: string) => {
        const [post] = await db
            .insert(Post)
            .values({ eid: crypto.randomUUID(), title, description: "", media_count: 0, library_id: libraryId })
            .returning();
        return post.id;
    };

    const createMedia = async (libraryId: string, title: string) => {
        const [media] = await db
            .insert(Media)
            .values({ eid: crypto.randomUUID(), title, description: "", type: MediaType.IMAGE, sort_order: 0, library_id: libraryId })
            .returning();
        return media.id;
    };

    const createTag = async (libraryId: string, name: string) => {
        const [tag] = await db
            .insert(Tag)
            .values({ name, normalized_name: name, library_id: libraryId, status: TagStatus.ACTIVE, source: TagSource.USER })
            .returning();
        return tag.id;
    };

    const createDraft = async (libraryId: string, ownerId: string) => {
        const [file] = await db
            .insert(DbFile)
            .values({ path: `tests/${crypto.randomUUID()}.png`, bucket: "test", mime_type: "image/png" })
            .returning();
        fileIds.push(file.id);
        const [draft] = await db
            .insert(DraftFile)
            .values({ file_id: file.id, library_id: libraryId, owner_id: ownerId, original_name: "draft.png" })
            .returning();
        return draft.id;
    };

    const request = (token: string, [router, path, method = "GET", body]: Route) =>
        router.request(path, {
            method,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    const listedIds = async (token: string, route: Route) => {
        const response = await request(token, route);
        expect(response.status).toBe(200);
        const { data } = (await response.json()) as { data: { list: { id: string }[]; total: number } };
        return { ids: data.list.map((item) => item.id), total: data.total };
    };

    /** Every route that names a library, sent with a valid body so only access can fail it. */
    const libraryRoutes = (id: string): Route[] => {
        const anyId = "018f0000-0000-7000-8000-000000000000";
        const draft = {
            type: MediaType.IMAGE,
            tracks: [{ draft_file_id: anyId, type: TrackType.IMAGE, purpose: TrackPurpose.CONTENT, quality: Quality.HIGH }],
        };
        return [
            [postRouter, `/list?library_id=${id}`],
            [postRouter, `/authors?library_id=${id}`],
            [postRouter, "/create", "POST", { library_id: id, title: "escape" }],
            [mediaRouter, `/list?library_id=${id}`],
            [mediaRouter, `/list?library_id=${id}&ai_coverage=incomplete`],
            [mediaRouter, "/regenerate-covers", "POST", { library_id: id, media_ids: [anyId] }],
            [tagRouter, `/list?library_id=${id}`],
            [tagRouter, "/create", "POST", { library_id: id, name: "escape" }],
            [tagRouter, "/merge", "POST", { library_id: id, source_tag_id: anyId, target_tag_id: crypto.randomUUID() }],
            [trashRouter, `/list?library_id=${id}`],
            [trashRouter, "/restore", "POST", { library_id: id, post_ids: [anyId] }],
            [trashRouter, "/delete", "POST", { library_id: id, post_ids: [anyId] }],
            [trashRouter, "/empty", "POST", { library_id: id }],
            [importRouter, `/draft/files?library_id=${id}`],
            [importRouter, "/draft/presign", "POST", { library_id: id, fileName: "a.png" }],
            [
                importRouter,
                "/draft/confirm",
                "POST",
                {
                    library_id: id,
                    draft_file_id: anyId,
                    fileName: "a.png",
                    path: "a.png",
                    bucket: "b",
                    mime_type: "image/png",
                    size: 1,
                    upload_token: "t",
                },
            ],
            [importRouter, "/draft/commit-media", "POST", { library_id: id, media_drafts: [draft] }],
            [taskRouter, "/create", "POST", { library_id: id, posts: [] }],
            [searchRouter, `/?library_id=${id}&keyword=secret`],
            [aiRouter, `/bindings/${id}`],
            [aiRouter, `/bindings/${id}`, "POST", {}],
            [aiRouter, `/status/${id}`],
            [aiRouter, `/status/${id}/progress`],
            [aiRouter, `/status/${id}/process`, "POST"],
            [aiRouter, `/status/${id}/redescribe`, "POST"],
        ];
    };

    /** Every route that names a post, media item, tag or draft instead of its library. */
    const itemRoutes = (postId: string, mediaId: string, tagId: string, draftId: string): Route[] => [
        [postRouter, `/detail/${postId}`],
        [postRouter, `/${postId}/media`],
        [mediaRouter, `/detail/${mediaId}`],
        [mediaRouter, `/${mediaId}/tracks`],
        [mediaRouter, `/${mediaId}/regenerate-cover`, "POST"],
        [tagRouter, "/update", "POST", { id: tagId, name: "stolen" }],
        [tagRouter, `/delete/${tagId}`, "POST"],
        [importRouter, `/draft/files/${draftId}/delete`, "POST"],
        [taskRouter, "/retry-sync", "POST", { post_ids: [postId] }],
        [taskRouter, "/retry-sync", "POST", { media_ids: [mediaId] }],
        [aiRouter, "/media/process", "POST", { post_ids: [postId] }],
        [aiRouter, "/media/process", "POST", { media_ids: [mediaId] }],
    ];

    const expectSameAsMissing = async (token: string, foreign: Route[], missing: Route[]) => {
        for (const [index, route] of foreign.entries()) {
            const foreignResponse = await request(token, route);
            const missingResponse = await request(token, missing[index]);

            expect([route[1], foreignResponse.status]).toEqual([route[1], 404]);
            expect([route[1], await foreignResponse.json()]).toEqual([route[1], await missingResponse.json()]);
        }
    };

    beforeAll(async () => {
        const alice = await createUser("alice");
        const bob = await createUser("bob");
        aliceLibrary = await createLibrary(alice, "alice main");
        aliceOtherLibrary = await createLibrary(alice, "alice other");
        aliceDeletedLibrary = await createLibrary(alice, "alice deleted", true);
        bobLibrary = await createLibrary(bob, "bob main");

        alicePost = await createPost(aliceLibrary, "alice post");
        aliceMedia = await createMedia(aliceLibrary, "alice media");
        aliceTag = await createTag(aliceLibrary, "alice-tag");
        otherLibraryPost = await createPost(aliceOtherLibrary, "alice other post");
        otherLibraryMedia = await createMedia(aliceOtherLibrary, "alice other media");
        bobPost = await createPost(bobLibrary, "secret post");
        await db.update(Post).set({ sync_status: SyncStatus.FAILED }).where(eq(Post.id, bobPost));
        bobMedia = await createMedia(bobLibrary, "secret media");
        bobTag = await createTag(bobLibrary, "secret-tag");
        bobDraft = await createDraft(bobLibrary, bob);

        ({ rawToken: aliceToken } = await ApiTokenService.generateToken(alice, "alice"));
        ({ rawToken: aliceScopedToken } = await ApiTokenService.generateToken(alice, "alice scoped", aliceLibrary));
    });

    afterAll(async () => {
        // Retrying an item queues its download.
        await db.delete(JobQueue).where(inArray(JobQueue.library_id, libraryIds));
        await db.delete(DraftFile).where(inArray(DraftFile.library_id, libraryIds));
        await db.delete(DbFile).where(inArray(DbFile.id, fileIds));
        await db.delete(Tag).where(inArray(Tag.library_id, libraryIds));
        await db.delete(Media).where(inArray(Media.library_id, libraryIds));
        await db.delete(Post).where(inArray(Post.library_id, libraryIds));
        await db.delete(ExternalApiToken).where(inArray(ExternalApiToken.owner_id, userIds));
        await db.delete(Library).where(inArray(Library.id, libraryIds));
        await db.delete(User).where(inArray(User.id, userIds));
    });

    test("another user's library answers exactly like a missing one", async () => {
        await expectSameAsMissing(aliceToken, libraryRoutes(bobLibrary), libraryRoutes(crypto.randomUUID()));
    });

    test("another user's items answer exactly like missing ones", async () => {
        await expectSameAsMissing(
            aliceToken,
            itemRoutes(bobPost, bobMedia, bobTag, bobDraft),
            itemRoutes(crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()),
        );
    });

    test("a library-scoped token cannot reach the owner's other libraries", async () => {
        for (const route of libraryRoutes(aliceOtherLibrary)) {
            const response = await request(aliceScopedToken, route);
            expect([route[1], response.status]).toEqual([route[1], 404]);
        }
    });

    test("a library-scoped token cannot reach items of the owner's other libraries", async () => {
        const otherTag = await createTag(aliceOtherLibrary, "other-tag");
        const otherDraft = await createDraft(aliceOtherLibrary, userIds[0]);

        for (const route of itemRoutes(otherLibraryPost, otherLibraryMedia, otherTag, otherDraft)) {
            const response = await request(aliceScopedToken, route);
            expect([route[1], response.status]).toEqual([route[1], 404]);
        }
    });

    test("a deleted library is gone for its owner too", async () => {
        for (const route of libraryRoutes(aliceDeletedLibrary)) {
            const response = await request(aliceToken, route);
            expect([route[1], response.status]).toEqual([route[1], 404]);
        }
    });

    test("refused requests change nothing", async () => {
        const [tag] = await db.select().from(Tag).where(eq(Tag.id, bobTag));
        const [post] = await db.select().from(Post).where(eq(Post.id, bobPost));
        const [draft] = await db.select().from(DraftFile).where(eq(DraftFile.id, bobDraft));

        expect(tag.name).toBe("secret-tag");
        expect(post.sync_status).toBe(SyncStatus.FAILED);
        expect(draft).toBeDefined();
        expect(
            await db
                .select()
                .from(Post)
                .where(and(eq(Post.library_id, bobLibrary), eq(Post.title, "escape"))),
        ).toEqual([]);
    });

    test("/media/list requires a library", async () => {
        const response = await request(aliceToken, [mediaRouter, "/list"]);

        expect(response.status).toBe(400);
    });

    test("the owner reads the content of their library", async () => {
        expect(await listedIds(aliceToken, [postRouter, `/list?library_id=${aliceLibrary}`])).toEqual({ ids: [alicePost], total: 1 });
        expect(await listedIds(aliceToken, [mediaRouter, `/list?library_id=${aliceLibrary}`])).toEqual({ ids: [aliceMedia], total: 1 });
    });

    test("a library-scoped token still works on its own library", async () => {
        const routes: Route[] = [
            [postRouter, `/authors?library_id=${aliceLibrary}`],
            [postRouter, `/detail/${alicePost}`],
            [mediaRouter, `/detail/${aliceMedia}`],
            [tagRouter, `/list?library_id=${aliceLibrary}`],
            [trashRouter, `/list?library_id=${aliceLibrary}`],
            [importRouter, `/draft/files?library_id=${aliceLibrary}`],
            [searchRouter, `/?library_id=${aliceLibrary}&keyword=alice`],
            [aiRouter, `/status/${aliceLibrary}/progress`],
        ];

        expect(await listedIds(aliceScopedToken, [postRouter, `/list?library_id=${aliceLibrary}`])).toEqual({ ids: [alicePost], total: 1 });
        for (const route of routes) {
            const response = await request(aliceScopedToken, route);
            expect([route[1], response.status]).toEqual([route[1], 200]);
        }
    });

    test("/task/retry-sync accepts session-less tokens with and without a library scope", async () => {
        for (const token of [aliceToken, aliceScopedToken]) {
            const response = await request(token, [taskRouter, "/retry-sync", "POST", { post_ids: [alicePost], media_ids: [aliceMedia] }]);
            expect(response.status).toBe(200);
        }
    });

    test("/tag/merge treats a foreign tag like a missing one", async () => {
        const merge = (targetId: string) =>
            request(aliceToken, [
                tagRouter,
                "/merge",
                "POST",
                { library_id: aliceLibrary, source_tag_id: aliceTag, target_tag_id: targetId },
            ]);

        const foreign = await merge(bobTag);
        const missing = await merge(crypto.randomUUID());

        expect(foreign.status).toBe(404);
        expect(await foreign.json()).toEqual(await missing.json());
    });
});
