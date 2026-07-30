import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "@/global/env";
import { relations } from "@/db/schema/relations";
import { Pool } from "pg";

if (!env.DB_URL) {
    throw new Error("DB_URL is not set");
}

export const pool = new Pool({
    connectionString: env.DB_URL,
    keepAlive: true,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
});

// Essential: Prevent idle client disconnect errors from crashing the Bun process
pool.on("error", (err) => {
    console.warn(`[DB Pool] Idle client connection disconnected/error: ${err.message}`);
});

export const db = drizzle({
    client: pool,
    relations,
});

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
