import * as v from "valibot";

const envSchema = v.object({
    SERVER_ENV: v.optional(v.picklist(["development", "production", "test"]), "development"),

    /** PostgreSQL URL */
    DB_URL: v.string(),

    /** DB Connection Pool Max Connections */
    DB_POOL_MAX: v.pipe(
        v.optional(v.string(), "10"),
        v.transform((v) => parseInt(v, 10)),
    ),

    /** DB Connection Pool Idle Timeout (ms) */
    DB_IDLE_TIMEOUT_MS: v.pipe(
        v.optional(v.string(), "15000"),
        v.transform((v) => parseInt(v, 10)),
    ),

    /** Redis URL */
    REDIS_URL: v.optional(v.string(), "redis://localhost:6379"),

    GITHUB_CLIENT_ID: v.optional(v.string()),
    GITHUB_CLIENT_SECRET: v.optional(v.string()),
    GOOGLE_CLIENT_ID: v.optional(v.string()),
    GOOGLE_CLIENT_SECRET: v.optional(v.string()),
    /** Resend API Key */
    RESEND_API_KEY: v.string(),
    RESEND_EMAIL_SENDER: v.string(),
    AUTH_SECRET: v.string(),

    /** Cloudflare Turnstile Keys */
    TURNSTILE_SITE_KEY: v.optional(v.string(), "1x00000000000000000000AA"),
    TURNSTILE_SECRET_KEY: v.optional(v.string(), "1x0000000000000000000000000000000AA"),

    BETTER_AUTH_URL: v.optional(v.string()),
    BETTER_AUTH_SECRET: v.optional(v.string()),

    TRUSTED_ORIGINS: v.pipe(
        v.optional(v.string(), ""),
        v.transform((v) => (v ? v.split(",") : [])),
    ),

    /** TikHub API Base URL */
    TIKHUB_API_BASE_URL: v.optional(v.string()),
    /** TikHub API Key */
    TIKHUB_API_KEY: v.optional(v.string()),

    S3_ENDPOINT: v.string(),
    S3_ACCESS_KEY_ID: v.string(),
    S3_SECRET_ACCESS_KEY: v.string(),
    S3_REGION: v.string(),
    S3_BUCKET: v.pipe(v.string(), v.nonEmpty("S3_BUCKET is required")),

    CDN_BASE_URL: v.string(),
    STORAGE_IS_PUBLIC: v.pipe(
        v.optional(v.string(), "false"),
        v.transform((v) => v === "true"),
    ),

    POST_UPDATE_THRESHOLD_HOURS: v.pipe(
        v.optional(v.string(), "24"),
        v.transform((v) => parseInt(v, 10)),
    ),
    CRON_SECRET: v.optional(v.string()),
});

export const env = v.parse(envSchema, process.env);
