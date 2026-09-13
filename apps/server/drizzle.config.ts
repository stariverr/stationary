import { defineConfig } from "drizzle-kit";

const dbUrl = process.env.DB_URL;
if (!dbUrl) {
    throw new Error("DB_URL environment variable is required for drizzle-kit");
}

export default defineConfig({
    schema: "./src/db/schema/index.ts",
    out: "./drizzle",
    dialect: "postgresql",
    schemaFilter: ["public"],
    dbCredentials: {
        url: dbUrl,
    },
});
