import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { resolveMigrationsFolder } from "./migrations-folder";

async function main() {
    const dbUrl = process.env.DB_URL;
    if (!dbUrl) {
        throw new Error("DB_URL environment variable is required to run migrations");
    }

    const parsedMax = Number.parseInt(process.env.DB_POOL_MAX ?? "2", 10);
    const max = Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 2;
    const migrationsFolder = resolveMigrationsFolder(import.meta.dir);

    console.log(`[Migrate] Running SQL migrations from ${migrationsFolder}...`);
    const pool = new Pool({
        connectionString: dbUrl,
        max,
        connectionTimeoutMillis: 10_000,
    });

    try {
        const db = drizzle({ client: pool });
        await migrate(db, { migrationsFolder });
        console.log("[Migrate] Database migrations completed.");
    } finally {
        await pool.end();
    }
}

await main().catch((err) => {
    console.error("[Migrate] Migration failed:", err);
    process.exit(1);
});
