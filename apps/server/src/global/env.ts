import { z } from "zod";

const envSchema = z.object({
    /** PostgreSQL URL */
    DB_URL: z.string(),

    /** Redis URL */
    REDIS_URL: z.string().default("redis://localhost:6379"),

    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    /** Resend API Key */
    RESEND_API_KEY: z.string(),
    AUTH_SECRET: z.string(),

    BETTER_AUTH_URL: z.string().optional(),
    BETTER_AUTH_SECRET: z.string().optional(),

    TRUSTED_ORIGINS: z
        .string()
        .default("")
        .transform((v) => (v ? v.split(",") : [])),

    /** TikHub API Base URL */
    TIKHUB_API_BASE_URL: z.string().optional(),
    /** TikHub API Key */
    TIKHUB_API_KEY: z.string().optional(),

    S3_ENDPOINT: z.string(),
    S3_ACCESS_KEY_ID: z.string(),
    S3_SECRET_ACCESS_KEY: z.string(),
    S3_REGION: z.string(),
    S3_BUCKET: z.string().nonempty("S3_BUCKET is required"),

    CDN_BASE_URL: z.string(),
    STORAGE_IS_PUBLIC: z
        .string()
        .default("false")
        .transform((v) => v === "true"),

    QSTASH_URL: z.string().optional(),
    QSTASH_TOKEN: z.string().nonempty("QSTASH_TOKEN is required"),
    QSTASH_CURRENT_SIGNING_KEY: z.string().optional(),
    QSTASH_NEXT_SIGNING_KEY: z.string().optional(),
    UPSTASH_WORKFLOW_URL: z.string().optional(),
    POST_UPDATE_THRESHOLD_HOURS: z
        .string()
        .default("24")
        .transform((v) => parseInt(v)),
    CRON_SECRET: z.string().optional(),
});

export const env = envSchema.parse(process.env);
