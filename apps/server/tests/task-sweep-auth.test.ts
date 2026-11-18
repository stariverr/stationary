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
const { default: taskApp } = await import("@/api/task");

const databaseTest = databaseUrl && env.DB_URL === databaseUrl ? test : test.skip;

const secret = "test-cron-secret";
const cronRoutes = ["/purge-stale-pending-drafts", "/sweep-orphan-tags"];
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
