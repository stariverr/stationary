import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import libraryRouter from "@/api/library";
import { DeleteStatus, ExternalApiToken, Library, Post, User } from "@/db/schema";
import { ApiTokenService } from "@/features/auth/api-token";
import { db } from "@/global/db";

/**
 * Drives the library routes through real API tokens against a real PostgreSQL.
 * Run with RUN_LIBRARY_DB_TESTS=1 and DB_URL pointing at a disposable instance.
 */
describe.skipIf(process.env.RUN_LIBRARY_DB_TESTS !== "1")("Library access control", () => {
    const missingLibraryId = crypto.randomUUID();
    const libraryIds: string[] = [];
    const userIds: string[] = [];

    let alice: string;
    let aliceLibrary: string;
    let aliceOtherLibrary: string;
    let bobLibrary: string;
    let aliceToken: string;
    let aliceScopedToken: string;

    const createUser = async (name: string) => {
        const [user] = await db.insert(User).values({ auth_id: crypto.randomUUID(), name }).returning();
        userIds.push(user.id);
        return user.id;
    };

    const createLibrary = async (ownerId: string, name: string) => {
        const [library] = await db.insert(Library).values({ name, description: "", owner_id: ownerId }).returning();
        libraryIds.push(library.id);
        return library.id;
    };

    const createPost = async (libraryId: string) => {
        const [post] = await db
            .insert(Post)
            .values({ eid: crypto.randomUUID(), title: "post", description: "", media_count: 0, library_id: libraryId })
            .returning();
        return post.id;
    };

    const request = (token: string, path: string, method = "GET", body?: unknown) =>
        libraryRouter.request(path, {
            method,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    const listedIds = async (token: string, query = "") => {
        const response = await request(token, `/list${query}`);
        const { data } = (await response.json()) as { data: { list: { id: string }[]; total: number } };
        return { ids: data.list.map((library) => library.id), total: data.total };
    };

    const libraryName = async (id: string) => {
        const [library] = await db.select({ name: Library.name }).from(Library).where(eq(Library.id, id));
        return library.name;
    };

    const postLibrary = async (id: string) => {
        const [post] = await db.select({ library_id: Post.library_id }).from(Post).where(eq(Post.id, id));
        return post.library_id;
    };

    /** Every route that addresses one library, sent with a valid body so only access can fail it. */
    const libraryRoutes = (id: string): [string, string, unknown?][] => [
        ["/update", "POST", { id, name: "renamed" }],
        [`/delete/${id}`, "POST"],
        [`/${id}/cover-jobs`, "POST", {}],
        [`/${id}/cover-config`, "GET"],
        [`/${id}/cover-config`, "PUT", { qualities: ["HIGH"] }],
    ];

    beforeAll(async () => {
        alice = await createUser("alice");
        const bob = await createUser("bob");
        aliceLibrary = await createLibrary(alice, "alice main");
        aliceOtherLibrary = await createLibrary(alice, "alice other");
        bobLibrary = await createLibrary(bob, "bob main");

        ({ rawToken: aliceToken } = await ApiTokenService.generateToken(alice, "alice"));
        ({ rawToken: aliceScopedToken } = await ApiTokenService.generateToken(alice, "alice scoped", aliceLibrary));
    });

    afterAll(async () => {
        await db.delete(Post).where(inArray(Post.library_id, libraryIds));
        await db.delete(ExternalApiToken).where(inArray(ExternalApiToken.owner_id, userIds));
        await db.delete(Library).where(inArray(Library.id, libraryIds));
        await db.delete(User).where(inArray(User.id, userIds));
    });

    test("/list returns only the caller's own libraries", async () => {
        const { ids, total } = await listedIds(aliceToken);

        expect(ids.sort()).toEqual([aliceLibrary, aliceOtherLibrary].sort());
        expect(total).toBe(2);
    });

    test("/list keyword search cannot reach another user's library", async () => {
        const { ids, total } = await listedIds(aliceToken, "?keyword=bob");

        expect(ids).toEqual([]);
        expect(total).toBe(0);
    });

    test("/list with a library-scoped token returns only that library", async () => {
        const { ids, total } = await listedIds(aliceScopedToken);

        expect(ids).toEqual([aliceLibrary]);
        expect(total).toBe(1);
    });

    test("another user's library answers exactly like a missing one", async () => {
        const foreign = libraryRoutes(bobLibrary);
        const missing = libraryRoutes(missingLibraryId);

        for (const [index, [path, method, body]] of foreign.entries()) {
            const foreignResponse = await request(aliceToken, path, method, body);
            const [missingPath, missingMethod, missingBody] = missing[index];
            const missingResponse = await request(aliceToken, missingPath, missingMethod, missingBody);

            expect([path, foreignResponse.status]).toEqual([path, 404]);
            expect(await foreignResponse.json()).toEqual(await missingResponse.json());
        }

        expect(await libraryName(bobLibrary)).toBe("bob main");
    });

    test("a library-scoped token cannot reach the owner's other libraries", async () => {
        for (const [path, method, body] of libraryRoutes(aliceOtherLibrary)) {
            const response = await request(aliceScopedToken, path, method, body);
            expect([path, response.status]).toEqual([path, 404]);
        }

        const [library] = await db.select().from(Library).where(eq(Library.id, aliceOtherLibrary));
        expect(library.name).toBe("alice other");
        expect(library.delete_status).toBe(DeleteStatus.ACTIVE);
    });

    test("a library-scoped token still works on its own library", async () => {
        const updated = await request(aliceScopedToken, "/update", "POST", { id: aliceLibrary, description: "scoped" });
        const config = await request(aliceScopedToken, `/${aliceLibrary}/cover-config`);

        expect(updated.status).toBe(200);
        expect(config.status).toBe(200);
    });

    test("the owner can rename and delete a library", async () => {
        const id = await createLibrary(alice, "disposable");

        const updated = await request(aliceToken, "/update", "POST", { id, name: "renamed" });
        expect(updated.status).toBe(200);
        expect(await libraryName(id)).toBe("renamed");

        const deleted = await request(aliceToken, `/delete/${id}`, "POST");
        expect(deleted.status).toBe(200);

        const afterDelete = await request(aliceToken, "/update", "POST", { id, name: "again" });
        expect(afterDelete.status).toBe(404);
    });

    test("a library-scoped token cannot create libraries", async () => {
        const response = await request(aliceScopedToken, "/create", "POST", { name: "escape" });

        expect(response.status).toBe(403);
        expect(await db.select().from(Library).where(eq(Library.name, "escape"))).toEqual([]);
    });

    test("/move-items cannot target another user's library", async () => {
        const postId = await createPost(aliceLibrary);

        const response = await request(aliceToken, "/move-items", "POST", { post_ids: [postId], target_library_id: bobLibrary });

        expect(response.status).toBe(404);
        expect(await postLibrary(postId)).toBe(aliceLibrary);
    });

    test("/move-items cannot pull items out of another user's library", async () => {
        const postId = await createPost(bobLibrary);

        const response = await request(aliceToken, "/move-items", "POST", { post_ids: [postId], target_library_id: aliceLibrary });

        expect(response.status).toBe(404);
        expect(await postLibrary(postId)).toBe(bobLibrary);
    });

    test("/move-items keeps a library-scoped token inside its library", async () => {
        const postId = await createPost(aliceOtherLibrary);

        const pulled = await request(aliceScopedToken, "/move-items", "POST", { post_ids: [postId], target_library_id: aliceLibrary });
        expect(pulled.status).toBe(404);
        expect(await postLibrary(postId)).toBe(aliceOtherLibrary);

        const moved = await request(aliceToken, "/move-items", "POST", { post_ids: [postId], target_library_id: aliceLibrary });
        expect(moved.status).toBe(200);
        expect(await postLibrary(postId)).toBe(aliceLibrary);
    });
});
