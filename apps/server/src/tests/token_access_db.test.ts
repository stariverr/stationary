import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";

import userRouter from "@/api/user";
import { DeleteStatus, ExternalApiToken, Library, User } from "@/db/schema";
import { ApiTokenService } from "@/features/auth/api-token";
import { db } from "@/global/db";

/**
 * Drives the token routes through real API tokens against a real PostgreSQL.
 * Run with RUN_TOKEN_DB_TESTS=1 and DB_URL pointing at a disposable instance.
 */
describe.skipIf(process.env.RUN_TOKEN_DB_TESTS !== "1")("API token access control", () => {
    const libraryIds: string[] = [];
    const userIds: string[] = [];

    let alice: string;
    let aliceLibrary: string;
    let aliceOtherLibrary: string;
    let aliceDeletedLibrary: string;
    let bobLibrary: string;
    let aliceToken: string;
    let aliceScopedToken: string;

    const createUser = async (name: string) => {
        const [user] = await db.insert(User).values({ auth_id: crypto.randomUUID(), name }).returning();
        userIds.push(user.id);
        return user.id;
    };

    const createLibrary = async (ownerId: string, name: string, deleteStatus = DeleteStatus.ACTIVE) => {
        const [library] = await db
            .insert(Library)
            .values({ name, description: "", owner_id: ownerId, delete_status: deleteStatus })
            .returning();
        libraryIds.push(library.id);
        return library.id;
    };

    const request = (token: string, path: string, method = "GET", body?: unknown) =>
        userRouter.request(path, {
            method,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });

    const tokensNamed = (name: string) => db.select().from(ExternalApiToken).where(eq(ExternalApiToken.name, name));

    beforeAll(async () => {
        alice = await createUser("alice");
        const bob = await createUser("bob");
        aliceLibrary = await createLibrary(alice, "alice main");
        aliceOtherLibrary = await createLibrary(alice, "alice other");
        aliceDeletedLibrary = await createLibrary(alice, "alice deleted", DeleteStatus.DELETED);
        bobLibrary = await createLibrary(bob, "bob main");

        ({ rawToken: aliceToken } = await ApiTokenService.generateToken(alice, "alice"));
        ({ rawToken: aliceScopedToken } = await ApiTokenService.generateToken(alice, "alice scoped", aliceLibrary));
    });

    afterAll(async () => {
        await db.delete(ExternalApiToken).where(inArray(ExternalApiToken.owner_id, userIds));
        await db.delete(Library).where(inArray(Library.id, libraryIds));
        await db.delete(User).where(inArray(User.id, userIds));
    });

    test("a library-scoped token cannot create any token", async () => {
        const bodies = [
            { name: "escape unscoped" },
            { name: "escape null", library_id: null },
            { name: "escape sibling", library_id: aliceOtherLibrary },
            { name: "escape same", library_id: aliceLibrary },
        ];

        for (const body of bodies) {
            const response = await request(aliceScopedToken, "/tokens", "POST", body);

            expect([body.name, response.status]).toEqual([body.name, 403]);
            expect(await tokensNamed(body.name)).toEqual([]);
        }
    });

    test("a library-scoped token cannot list tokens", async () => {
        const response = await request(aliceScopedToken, "/tokens");

        expect(response.status).toBe(403);
    });

    test("a library-scoped token cannot revoke tokens", async () => {
        const { token } = await ApiTokenService.generateToken(alice, "revocation target");

        const response = await request(aliceScopedToken, `/tokens/${token.id}`, "DELETE");

        expect(response.status).toBe(403);
        const [stored] = await tokensNamed("revocation target");
        expect(stored.revoke_time).toBeNull();
    });

    test("a library-scoped token keeps working outside the token routes", async () => {
        const response = await request(aliceScopedToken, "/");

        expect(response.status).toBe(200);
    });

    test("creating a token for another user's library answers exactly like a missing one", async () => {
        const foreign = await request(aliceToken, "/tokens", "POST", { name: "foreign", library_id: bobLibrary });
        const missing = await request(aliceToken, "/tokens", "POST", { name: "missing", library_id: crypto.randomUUID() });

        expect(foreign.status).toBe(404);
        expect(await foreign.json()).toEqual(await missing.json());
        expect(await tokensNamed("foreign")).toEqual([]);
        expect(await tokensNamed("missing")).toEqual([]);
    });

    test("creating a token for a deleted library is refused", async () => {
        const response = await request(aliceToken, "/tokens", "POST", { name: "deleted", library_id: aliceDeletedLibrary });

        expect(response.status).toBe(404);
        expect(await tokensNamed("deleted")).toEqual([]);
    });

    test("the owner can create a token scoped to their library", async () => {
        const response = await request(aliceToken, "/tokens", "POST", { name: "scoped", library_id: aliceLibrary });

        expect(response.status).toBe(200);
        const { data } = (await response.json()) as { data: { library_id: string | null } };
        expect(data.library_id).toBe(aliceLibrary);
    });

    test("the owner can create, list and revoke an unscoped token", async () => {
        const created = await request(aliceToken, "/tokens", "POST", { name: "unscoped" });
        expect(created.status).toBe(200);
        const { data: token } = (await created.json()) as { data: { id: string; library_id: string | null } };
        expect(token.library_id).toBeNull();

        const listed = await request(aliceToken, "/tokens");
        const { data: tokens } = (await listed.json()) as { data: { id: string }[] };
        expect(tokens.map(({ id }) => id)).toContain(token.id);

        const revoked = await request(aliceToken, `/tokens/${token.id}`, "DELETE");
        expect(revoked.status).toBe(200);
    });
});
