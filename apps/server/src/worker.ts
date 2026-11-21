import { pool } from "@/global/db";
import { destroyKVStore } from "@/global/kv";
import { startWorkerRuntime } from "@/infra/queue/runtime";

console.log("[Worker] Starting standalone queue worker...");

let isShuttingDown = false;
const shutdown = async (reason: string, exitCode = 0) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[Worker] Shutting down gracefully: ${reason}`);

    try {
        await workerRuntime.stop();
        await Promise.allSettled([destroyKVStore(), pool.end()]);
        console.log("[Worker] Graceful shutdown completed.");
    } catch (err) {
        console.error("[Worker] Error during graceful shutdown:", err);
        exitCode = exitCode || 1;
    } finally {
        process.exit(exitCode);
    }
};

const workerRuntime = startWorkerRuntime(() => {
    void shutdown("too many stuck runs", 1);
});

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
    console.error("[Worker] Unhandled rejection:", reason);
});
