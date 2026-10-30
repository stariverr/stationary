import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";

// Purges every expired file row in the target database, so the real-database test only runs
// against a URL named explicitly here, never the DB_URL loaded from .env.
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
const { s3 } = await import("@/global/s3");
const { DeleteStatus, File } = await import("@/db/schema");
const { default: taskApp } = await import("@/api/task");
const { eq } = await import("drizzle-orm");

const databaseTest = databaseUrl && env.DB_URL === databaseUrl ? test : test.skip;

const secret = "test-cron-secret";
const purge = (headers: Record<string, string> = {}) => taskApp.request("/purge-expired-files", { method: "POST", headers });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("POST /task/purge-expired-files", () => {
    const originalSecret = env.CRON_SECRET;
    const selectSpy = spyOn(db, "select");

    beforeAll(() => {
        env.CRON_SECRET = secret;
    });

    afterEach(() => {
        env.CRON_SECRET = secret;
        selectSpy.mockReset();
    });

    afterAll(() => {
        env.CRON_SECRET = originalSecret;
        selectSpy.mockRestore();
    });

    test.each([
        ["no credential", {}, 401],
        ["a wrong secret", bearer("wrong-secret"), 401],
        ["a secret in a non-Bearer scheme", { Authorization: `Basic ${secret}` }, 400],
    ] as const)("refuses %s before touching the database", async (_, headers, status) => {
        const res = await purge(headers);

        expect(res.status).toBe(status);
        expect(await res.json()).toMatchObject({ success: false, message: "Unauthorized" });
        expect(selectSpy).not.toHaveBeenCalled();
    });

    test.each([
        ["unset", undefined],
        ["empty", ""],
    ])("refuses every token while CRON_SECRET is %s", async (_, configured) => {
        env.CRON_SECRET = configured;

        for (const token of [secret, "undefined"]) {
            expect((await purge(bearer(token))).status).toBe(401);
        }
        expect(selectSpy).not.toHaveBeenCalled();
    });

    test("runs the purge for the scheduler's secret", async () => {
        selectSpy.mockReturnValue({
            from: () => ({ where: () => ({ limit: async () => [] }) }),
        } as never);

        const res = await purge(bearer(secret));

        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ success: true, data: { purgedCount: 0, failedCount: 0 } });
    });

    databaseTest("deletes expired files from the database and S3", async () => {
        selectSpy.mockRestore();
        const s3Delete = spyOn(s3, "delete").mockResolvedValue(undefined as never);
        const now = Temporal.Now.instant();
        const row = (name: string, deleteTime: Temporal.Instant) => ({
            mime_type: "image/png",
            path: `task-purge-test/${crypto.randomUUID()}/${name}`,
            bucket: "test-bucket",
            delete_status: DeleteStatus.DELETED,
            delete_time: deleteTime,
        });
        const [expired, recent] = await db
            .insert(File)
            .values([row("expired", now.subtract({ hours: 31 * 24 })), row("recent", now)])
            .returning();

        try {
            const res = await purge(bearer(secret));

            expect(res.status).toBe(200);
            expect(s3Delete).toHaveBeenCalledWith(expired!.path, { bucket: expired!.bucket });
            expect(await db.select().from(File).where(eq(File.id, expired!.id))).toEqual([]);
            expect(await db.select().from(File).where(eq(File.id, recent!.id))).toHaveLength(1);
        } finally {
            s3Delete.mockRestore();
            await db.delete(File).where(eq(File.id, recent!.id));
        }
    });
});
