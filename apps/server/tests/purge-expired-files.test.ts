import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

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
    DB_URL: "postgres://test:test@localhost:5432/test",
});

const { db } = await import("@/global/db");
const { s3 } = await import("@/global/s3");
const { purgeExpiredFiles, startFilePurgeSchedule, stopFilePurgeSchedule } = await import("@/features/trash/purge-expired-files");

const dialect = new PgDialect();
const file = { id: "018f0000-0000-7000-8000-000000000001", path: "expired.png", bucket: "test-bucket" };

// Serves the file until the query carries its id as the cursor, like a real page walk.
function mockExpiredFile() {
    return spyOn(db, "select").mockImplementation((() => ({
        from: () => ({
            where: (condition: SQL) => ({
                orderBy: () => ({
                    limit: async () => (dialect.sqlToQuery(condition).params.includes(file.id) ? [] : [file]),
                }),
            }),
        }),
    })) as never);
}

describe("purgeExpiredFiles", () => {
    afterEach(() => {
        stopFilePurgeSchedule();
    });

    test("finishes when a file keeps failing and leaves it for the next run", async () => {
        const selectSpy = mockExpiredFile();
        const deleteSpy = spyOn(s3, "delete").mockRejectedValue(new Error("S3 is down"));

        expect(await purgeExpiredFiles()).toEqual({
            purgedCount: 0,
            failedCount: 1,
            errors: [{ fileId: file.id, error: "S3 is down" }],
        });

        selectSpy.mockRestore();
        deleteSpy.mockRestore();
    });

    test("schedule purges immediately and survives a failed run", async () => {
        const selectSpy = spyOn(db, "select").mockImplementation((() => {
            throw new Error("database is down");
        }) as never);
        const errorSpy = spyOn(console, "error").mockImplementation(() => {});

        startFilePurgeSchedule();
        await Bun.sleep(0);

        expect(selectSpy).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith("[FilePurge] Scheduled purge failed: database is down");

        selectSpy.mockRestore();
        errorSpy.mockRestore();
    });
});
