import { defineConfig } from 'drizzle-kit';
import { env } from './src/global/env';

export default defineConfig({
    schema: './src/db/schema/index.ts',
    out: './drizzle',
    dialect: 'postgresql',
    schemaFilter: ['public'],
    dbCredentials: {
        url: env.DB_URL,
    },
});
