import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "@/global/env";
import * as schema from "../db/schema";
import { Pool } from "pg";
import { relations } from "@/db/schema/relations";

if (!env.DB_URL) {
    throw new Error("DB_URL is not set");
}

const pool = new Pool({
    connectionString: env.DB_URL,
    keepAlive: true,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    max: 20,
});

pool.on("connect", (client) => {
    client.on("error", (err) => {
        const msg = err.message || String(err);
        const code = (err as { code?: string }).code;
        const isDisconnect =
            msg.includes("Connection terminated") ||
            msg.includes("connection closed") ||
            code === "ECONNRESET" ||
            code === "EPIPE" ||
            code === "ENOTFOUND" ||
            code === "57P01" ||
            code === "57P02" ||
            code === "57P03";

        if (isDisconnect) {
            console.warn(`[DB Client] Database client connection reset/terminated: ${msg}`);
        } else {
            console.error("[DB Client] Unexpected error on database client connection:", err);
        }
    });
});

pool.on("error", (err) => {
    const msg = err.message || String(err);
    const code = (err as { code?: string }).code;
    const isDisconnect =
        msg.includes("Connection terminated") ||
        msg.includes("connection closed") ||
        code === "ECONNRESET" ||
        code === "EPIPE" ||
        code === "ENOTFOUND" ||
        code === "57P01" ||
        code === "57P02" ||
        code === "57P03";

    if (isDisconnect) {
        console.warn(`[DB Pool] Idle database client disconnected: ${msg}`);
    } else {
        console.error("[DB Pool] Unexpected error on idle database client:", err);
    }
});

export const db = drizzle({
    client: pool,
    relations,
});

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
