import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

// The sweeps run across the whole target database, so the real-database tests only run against
// a URL named explicitly here, never the DB_URL loaded from .env.
const databaseUrl = process.env.TASK_TEST_DB_URL;

Object.assign(process.env, {
    AUTH_SECRET: "test-auth-secret",
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    RESEND_API_KEY: "test-resend-key",
    RESEND_EMAIL_SENDER: "test@example.com",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REGION: "test-region",
    S3_BUCKET: "test-bucket",
    CDN_BASE_URL: "http://localhost:9000/test-bucket",
    DB_URL: databaseUrl ?? "postgres://test:test@localhost:5432/test",
});

const { env } = await import("@/global/env");
const { db } = await import("@/global/db");
const { ApiTokenService } = await import("@/features/auth/api-token");
const { Library, Media, MediaType, Post, SyncStatus, Track, TrackPurpose, TrackType, User } = await import("@/db/schema");
const { Quality } = await import("@/lib/types");
const { default: taskApp } = await import("@/api/task");
const { eq, inArray } = await import("drizzle-orm");

const databaseTest = databaseUrl && env.DB_URL === databaseUrl ? test : test.skip;

const secret = "test-cron-secret";
const cronRoutes = ["/purge-stale-pending-drafts", "/sweep-stuck-tasks", "/sweep-orphan-tags", "/sweep-media-track-integrity"];
const post = (route: string, headers: Record<string, string> = {}) => taskApp.request(route, { method: "POST", headers });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe.each(cronRoutes)("POST /task%s", (route) => {
    const originalSecret = env.CRON_SECRET;
    const selectSpy = spyOn(db, "select");
    const updateSpy = spyOn(db, "update");

    beforeAll(() => {
        env.CRON_SECRET = secret;
    });

    afterEach(() => {
        env.CRON_SECRET = secret;
        selectSpy.mockClear();
        updateSpy.mockClear();
    });

    afterAll(() => {
        env.CRON_SECRET = originalSecret;
        selectSpy.mockRestore();
        updateSpy.mockRestore();
    });

    test.each([
        ["no credential", {}, 401],
        ["a wrong secret", bearer("wrong-secret"), 401],
        ["the secret in X-Internal-Token", { "X-Internal-Token": secret }, 401],
        ["a secret in a non-Bearer scheme", { Authorization: `Basic ${secret}` }, 400],
    ] as const)("refuses %s before touching the database", async (_, headers, status) => {
        const res = await post(route, headers);

        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ success: false, message: "Unauthorized" });
        expect(selectSpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
    });

    test.each([
        ["unset", undefined],
        ["empty", ""],
    ])("refuses every token while CRON_SECRET is %s", async (_, configured) => {
        env.CRON_SECRET = configured;

        for (const token of [secret, "undefined"]) {
            expect((await post(route, bearer(token))).status).toBe(401);
        }
        expect(selectSpy).not.toHaveBeenCalled();
        expect(updateSpy).not.toHaveBeenCalled();
    });

    databaseTest("runs for the scheduler's secret", async () => {
        const res = await post(route, bearer(secret));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true });
    });
});

describe("POST /task/sweep-stuck-library", () => {
    const sweep = (libraryId: string, headers: Record<string, string> = {}) =>
        taskApp.request("/sweep-stuck-library", {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify({ library_id: libraryId }),
        });

    test("refuses a request with no user", async () => {
        const res = await sweep(crypto.randomUUID());

        expect(res.status).toBe(401);
    });

    databaseTest("does not accept the cron secret", async () => {
        const verifyToken = spyOn(ApiTokenService, "verifyToken").mockResolvedValue(null);
        const originalSecret = env.CRON_SECRET;
        env.CRON_SECRET = secret;

        try {
            expect((await sweep(crypto.randomUUID(), bearer(secret))).status).toBe(401);
        } finally {
            env.CRON_SECRET = originalSecret;
            verifyToken.mockRestore();
        }
    });

    databaseTest("sweeps only stuck items of the caller's own library", async () => {
        const stale = Temporal.Now.instant().subtract({ hours: 2 });
        const [owner, stranger] = await db
            .insert(User)
            .values(["owner", "stranger"].map((name) => ({ name, auth_id: crypto.randomUUID() })))
            .returning();
        const [own, other, foreign] = await db
            .insert(Library)
            .values([
                { name: "own", description: "", owner_id: owner!.id },
                { name: "other", description: "", owner_id: owner!.id },
                { name: "foreign", description: "", owner_id: stranger!.id },
            ])
            .returning();

        const seed = async (libraryId: string) => {
            const [stuckPost] = await db
                .insert(Post)
                .values({
                    eid: crypto.randomUUID(),
                    title: "stuck",
                    description: "",
                    media_count: 1,
                    library_id: libraryId,
                    sync_status: SyncStatus.IN_PROGRESS,
                    update_time: stale,
                })
                .returning();
            const [stuckMedia] = await db
                .insert(Media)
                .values({
                    sort_order: 0,
                    eid: crypto.randomUUID(),
                    post_id: stuckPost!.id,
                    library_id: libraryId,
                    title: "stuck",
                    description: "",
                    type: MediaType.VIDEO,
                    sync_status: SyncStatus.IN_PROGRESS,
                    update_time: stale,
                })
                .returning();
            const [stuckTrack] = await db
                .insert(Track)
                .values({
                    media_id: stuckMedia!.id,
                    type: TrackType.VIDEO,
                    purpose: TrackPurpose.CONTENT,
                    quality: Quality.HIGH,
                    variant_key: "original",
                    sync_status: SyncStatus.IN_PROGRESS,
                    update_time: stale,
                })
                .returning();
            return { postId: stuckPost!.id, mediaId: stuckMedia!.id, trackId: stuckTrack!.id };
        };

        const statuses = async ({ postId, mediaId, trackId }: Awaited<ReturnType<typeof seed>>) => {
            const [postRow] = await db.select().from(Post).where(eq(Post.id, postId));
            const [mediaRow] = await db.select().from(Media).where(eq(Media.id, mediaId));
            const [trackRow] = await db.select().from(Track).where(eq(Track.id, trackId));
            return [postRow!.sync_status, mediaRow!.sync_status, trackRow!.sync_status];
        };

        const ownItems = await seed(own!.id);
        const otherItems = await seed(other!.id);
        const foreignItems = await seed(foreign!.id);
        const stuck = [SyncStatus.IN_PROGRESS, SyncStatus.IN_PROGRESS, SyncStatus.IN_PROGRESS];
        const token = (libraryId: string | null) =>
            spyOn(ApiTokenService, "verifyToken").mockResolvedValue({ owner_id: owner!.id, library_id: libraryId } as never);

        const unscoped = token(null);
        try {
            const res = await sweep(own!.id, bearer("st_test"));

            expect(res.status).toBe(200);
            expect(await res.json()).toMatchObject({ success: true, data: { stuck_entities_swept: 3 } });
            expect(await statuses(ownItems)).toEqual([SyncStatus.FAILED, SyncStatus.FAILED, SyncStatus.FAILED]);
            expect(await statuses(otherItems)).toEqual(stuck);

            expect((await sweep(foreign!.id, bearer("st_test"))).status).toBe(404);
            expect((await sweep(crypto.randomUUID(), bearer("st_test"))).status).toBe(404);
            expect(await statuses(foreignItems)).toEqual(stuck);

            unscoped.mockRestore();
            const scoped = token(own!.id);
            expect((await sweep(other!.id, bearer("st_test"))).status).toBe(404);
            expect(await statuses(otherItems)).toEqual(stuck);
            scoped.mockRestore();
        } finally {
            unscoped.mockRestore();
            const items = [ownItems, otherItems, foreignItems];
            await db.delete(Track).where(inArray(Track.id, items.map((item) => item.trackId)));
            await db.delete(Media).where(inArray(Media.id, items.map((item) => item.mediaId)));
            await db.delete(Post).where(inArray(Post.id, items.map((item) => item.postId)));
            await db.delete(Library).where(inArray(Library.id, [own!.id, other!.id, foreign!.id]));
            await db.delete(User).where(inArray(User.id, [owner!.id, stranger!.id]));
        }
    });
});
