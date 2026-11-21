import { Hono } from "hono";
import { pool } from "@/global/db";
import { kv } from "@/global/kv";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";

const HEALTH_CHECK_TIMEOUT_MS = 3_000;

export interface HealthDependencies {
    checkDb: () => Promise<boolean>;
    checkRedis: () => Promise<boolean>;
    timeoutMs?: number;
}

async function runWithTimeout(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            check().catch(() => false),
            new Promise<boolean>((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref?.();
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

const defaultDeps: HealthDependencies = {
    checkDb: async () => {
        await pool.query("SELECT 1");
        return true;
    },
    checkRedis: () => kv.ping(),
};

/** Creates the health router used by Kubernetes liveness and readiness probes. */
export function createHealthApp(deps: HealthDependencies = defaultDeps) {
    const app = new Hono();
    const timeoutMs = deps.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

    app.get("/live", (c) => {
        return c.json(success(Code.SUCCESS, { status: "ok" }));
    });

    const readinessHandler = async (c: import("hono").Context) => {
        const [dbOk, redisOk] = await Promise.all([runWithTimeout(deps.checkDb, timeoutMs), runWithTimeout(deps.checkRedis, timeoutMs)]);
        const checks = {
            db: dbOk ? "ok" : "error",
            redis: redisOk ? "ok" : "error",
        } as const;

        if (!dbOk || !redisOk) {
            console.warn("[Health] Readiness check failed:", checks);
            return c.json(error(Code.SERVICE_UNAVAILABLE, "Service dependencies are unhealthy"), 503);
        }

        return c.json(success(Code.SUCCESS, { status: "ok", checks }));
    };

    app.get("/", readinessHandler);
    app.get("/ready", readinessHandler);

    return app;
}

const healthApp = createHealthApp();
export default healthApp;
