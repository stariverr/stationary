import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from "@/global/env";
import * as schema from '../db/schema';
import { Pool } from 'pg';
import { relations } from '@/db/schema/relations';

if (!env.DB_URL) {
    throw new Error('DB_URL is not set');
}


export const db = drizzle(env.DB_URL, {
    relations
});