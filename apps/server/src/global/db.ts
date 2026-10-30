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
    keepAliveInitialDelayMillis: 10_000,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: 10_000,
    // Whatever hangs in the database would otherwise hold its connection, its locks and its caller forever.
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    lock_timeout: 30_000,
    idle_in_transaction_session_timeout: 60_000,
    // Those need a server that answers; this one holds when it or the network does not.
    query_timeout: env.DB_STATEMENT_TIMEOUT_MS && env.DB_STATEMENT_TIMEOUT_MS + 10_000,
});

// 1. Prevent idle client disconnect errors from crashing the Bun process
pool.on("error", (err) => {
    console.warn(`[DB Pool] Idle client disconnected/error: ${err.message}`);
});

// 2. Prevent active/acquired client disconnect errors from crashing the Bun process
pool.on("connect", (client) => {
    client.on("error", (err) => {
        console.warn(`[DB Client] Connection error: ${err.message}`);
    });
});

export const db = drizzle({
    client: pool,
    relations,
});

export type DB = typeof db;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Transaction = Tx;
export type DbClient = DB | Tx;
