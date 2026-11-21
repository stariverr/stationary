import { Hono } from "hono";
import { cors } from "hono/cors";
import post from "@/api/post";
import media from "@/api/media";
import task from "@/api/task";
import { env } from "@/global/env";
import user from "@/api/user";
import library from "@/api/library";
import { aiRouter } from "@/api/ai";
import search from "@/api/search";
import tag from "@/api/tag";
import trash from "@/api/trash";
import authRouter from "@/api/auth";
import importRouter from "@/api/import";
import { jobsApp } from "@/api/jobs";
import healthApp from "@/api/health";
import { pool } from "@/global/db";
import { destroyKVStore } from "@/global/kv";
import { startWorkerRuntime, type WorkerRuntime } from "@/infra/queue/runtime";

let workerRuntime: WorkerRuntime | null = null;

// 1. Start the reconcile queue worker unless running in HTTP-only (`api`) mode
if (env.SERVER_ROLE === "all") {
    workerRuntime = startWorkerRuntime(() => {
        void shutdown("too many stuck runs", 1);
    });
} else {
    console.log("[Server] Running in API-only mode (SERVER_ROLE=api); background worker disabled.");
}

// 2. Graceful Shutdown Handlers
let isShuttingDown = false;
const shutdown = async (reason: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Shutting down gracefully: ${reason}`);

    try {
        if (workerRuntime) {
            await workerRuntime.stop();
        }
        await Promise.allSettled([destroyKVStore(), pool.end()]);
        console.log("[Server] Graceful shutdown completed.");
    } catch (err) {
        console.error("[Server] Error during graceful shutdown:", err);
    } finally {
        process.exit(exitCode);
    }
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    console.error("[Server] Unhandled rejection:", reason);
});

const app = new Hono();

app.get("/", (c) => {
    return c.text("Hello Hono!");
});

app.use(
    "*",
    cors({
        origin: env.TRUSTED_ORIGINS,
        allowMethods: ["GET", "HEAD", "PUT", "POST", "DELETE", "PATCH", "OPTIONS"],
        exposeHeaders: ["Content-Length"],
        maxAge: 600,
        credentials: true,
    }),
);

// Custom logging middleware
app.use("*", async (c, next) => {
    const { method, path } = c.req;
    console.log(`[Request] ${method} ${path}`);

    await next();

    const status = c.res.status;
    if (status >= 300 && status < 400) {
        const redirectUrl = c.res.headers.get("Location");
        console.log(`[Redirect] -> ${redirectUrl}`);
    }
});

// Mount all routes
app.route("/api/health", healthApp);
app.route("/api/auth", authRouter);
app.route("/api/post", post);
app.route("/api/media", media);
app.route("/api/import", importRouter);
app.route("/api/task", task);
app.route("/api/user", user);
app.route("/api/library", library);
app.route("/api/ai", aiRouter);
app.route("/api/search", search);
app.route("/api/tag", tag);
app.route("/api/trash", trash);
app.route("/api/jobs", jobsApp);

const port = 9400;
console.log(`Server is running on port ${port}`);

export default {
    port,
    hostname: "0.0.0.0",
    idleTimeout: 60,
    fetch: app.fetch,
};
