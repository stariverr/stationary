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

const processes = [caddyProc, serverProc, webProc];
let stopping = false;

// The container ends with this process, so it has to outlive the others: the server may still be draining its queue.
const stopAll = () => {
    stopping = true;
    for (const proc of processes) proc.kill();
    return Promise.all(processes.map((proc) => proc.exited));
};

const shutdown = async (signal: string) => {
    if (stopping) return;
    console.log(`[Stationary] Received ${signal}, gracefully terminating processes...`);
    await stopAll();
    // The others die by the signal; the server says how its shutdown went, e.g. 1 if it was already restarting.
    process.exit(await serverProc.exited);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// If any critical process exits unexpectedly, terminate the container so the orchestrator restarts it
Promise.race([serverProc.exited, webProc.exited, caddyProc.exited]).then(async (code) => {
    if (stopping) return;
    console.log(`[Stationary] Subprocess exited with code ${code}, shutting down container...`);
    await stopAll();
    process.exit(code || 1);
});
