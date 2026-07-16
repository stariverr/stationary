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
});

pool.on("error", (err) => {
    console.error("Unexpected error on idle database client", err);
});

export const db = drizzle({
    client: pool,
    relations,
});

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
