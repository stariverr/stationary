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
import { startFilePurgeSchedule, stopFilePurgeSchedule } from "@/features/trash/purge-expired-files";
import { pipelineHandlers } from "@/infra/queue/handlers";
import { QueueWorker } from "@/infra/queue/worker";
// 1. Start the reconcile queue worker, which runs every background pipeline
const queueWorker = new QueueWorker(pipelineHandlers);
queueWorker.start();
startFilePurgeSchedule();

// 2. Graceful Shutdown Handlers
let isShuttingDown = false;
const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Received ${signal}, starting graceful shutdown...`);

    try {
        stopFilePurgeSchedule();
        await queueWorker.drain();
        console.log("[Server] Graceful shutdown completed.");
    } catch (err) {
        console.error("[Server] Error during graceful shutdown:", err);
    } finally {
        process.exit(0);
    }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
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
