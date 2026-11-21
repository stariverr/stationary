import { describe, expect, test } from "bun:test";
import { createHealthApp } from "@/api/health";
import { Code } from "@/lib/code";

describe("health endpoints", () => {
    test("GET /live returns 200 without invoking dependency checks", async () => {
        let called = false;
        const app = createHealthApp({
            checkDb: async () => {
                called = true;
                return false;
            },
            checkRedis: async () => {
                called = true;
                return false;
            },
        });

        const res = await app.request("/live");
        const body = (await res.json()) as { success: boolean; code: number; data: { status: string } };

        expect(res.status).toBe(200);
        expect(called).toBe(false);
        expect(body.success).toBe(true);
        expect(body.code).toBe(Code.SUCCESS);
        expect(body.data.status).toBe("ok");
    });

    test("GET / and /ready return 200 when db and redis are healthy", async () => {
        const app = createHealthApp({
            checkDb: async () => true,
            checkRedis: async () => true,
        });

        for (const path of ["/", "/ready"]) {
            const res = await app.request(path);
            const body = (await res.json()) as {
                success: boolean;
                code: number;
                data: { status: string; checks: { db: string; redis: string } };
            };

            expect(res.status).toBe(200);
            expect(body.success).toBe(true);
            expect(body.code).toBe(Code.SUCCESS);
            expect(body.data).toEqual({
                status: "ok",
                checks: { db: "ok", redis: "ok" },
            });
        }
    });

    test("GET / returns 503 when db or redis fails", async () => {
        const app = createHealthApp({
            checkDb: async () => true,
            checkRedis: async () => false,
        });

        const res = await app.request("/");
        const body = (await res.json()) as { success: boolean; code: number; data: null };

        expect(res.status).toBe(503);
        expect(body.success).toBe(false);
        expect(body.code).toBe(Code.SERVICE_UNAVAILABLE);
        expect(body.data).toBeNull();
    });

    test("GET / returns 503 when a dependency check times out", async () => {
        const app = createHealthApp({
            checkDb: () => new Promise(() => {}),
            checkRedis: async () => true,
            timeoutMs: 20,
        });

        const res = await app.request("/");
        expect(res.status).toBe(503);
    });
});
