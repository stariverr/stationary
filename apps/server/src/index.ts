import { Hono } from "hono";
import { cors } from "hono/cors";
import post from "@/api/post";
import media from "@/api/media";
import task from "@/api/task";
import { env } from "@/global/env";
import user from "@/api/user";
import library from "@/api/library";
import search from "@/api/search";
import tag from "@/api/tag";
import authRouter from "@/api/auth";
import importRouter from "@/api/import";
import { jobsApp } from "@/api/jobs";
import { jobRunner } from "@/infra/jobs/runner";
import { JobSweeper } from "@/infra/jobs/sweeper";
import { initJobHandlers } from "@/services/job_handlers";
// 1. Initialize Task Handlers Strategy Registry
initJobHandlers();

// 2. Start In-Process Task JobRunner & Sweeper
jobRunner.start();
JobSweeper.start(30000);

// 3. Graceful Shutdown Handlers
let isShuttingDown = false;
const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Server] Received ${signal}, starting graceful shutdown...`);

    try {
        JobSweeper.stop();
        await jobRunner.drain(15000);
        console.log("[Server] Graceful shutdown completed.");
    } catch (err) {
        console.error("[Server] Error during graceful shutdown:", err);
    } finally {
        process.exit(0);
    }
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

const app = new Hono();

app.get("/", (c) => {
    return c.text("Hello Hono!");
});

app.use(
    "*",
    cors({
        origin: env.TRUSTED_ORIGINS,
        allowHeaders: ["Content-Type", "Authorization"],
        allowMethods: ["POST", "GET", "PUT", "OPTIONS"],
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
app.route("/api/search", search);
app.route("/api/tag", tag);
app.route("/api/jobs", jobsApp);

const port = 9400;
console.log(`Server is running on port ${port}`);

export default {
    port,
    hostname: "0.0.0.0",
    idleTimeout: 60,
    fetch: app.fetch,
};
