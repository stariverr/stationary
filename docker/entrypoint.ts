import { spawn } from "bun";

console.log("[Stationary] Starting Server (API on 9400), Web (Nuxt on 3000), and Caddy Gateway on 4000...");

const serverProc = spawn(["bun", "run", "--bun", "/app/server/index.js"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
        ...process.env,
        PORT: "9400",
    },
});

const webProc = spawn(["node", "/app/web/.output/server/index.mjs"], {
    stdout: "inherit",
    stderr: "inherit",
    env: {
        ...process.env,
        PORT: "3000",
        HOST: "127.0.0.1",
        NUXT_API_BASE_URL: "http://127.0.0.1:9400",
    },
});

const caddyProc = spawn(["caddy", "run", "--config", "/app/Caddyfile"], {
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
});

const shutdown = (signal: string) => {
    console.log(`[Stationary] Received ${signal}, gracefully terminating processes...`);
    caddyProc.kill();
    serverProc.kill();
    webProc.kill();
    process.exit(0);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// If any critical process exits unexpectedly, terminate the container so the orchestrator restarts it
Promise.race([serverProc.exited, webProc.exited, caddyProc.exited]).then((code) => {
    console.log(`[Stationary] Subprocess exited with code ${code}, shutting down container...`);
    caddyProc.kill();
    serverProc.kill();
    webProc.kill();
    process.exit(code || 1);
});
