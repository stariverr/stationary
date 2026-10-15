import { isIP } from "node:net";
import * as v from "valibot";

function isCidr(value: string): boolean {
    const [address = "", prefix = "", ...rest] = value.split("/");
    const family = isIP(address);
    return rest.length === 0 && family !== 0 && /^\d+$/.test(prefix) && Number(prefix) <= (family === 4 ? 32 : 128);
}

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
    /** 32-byte base64 key that encrypts stored credentials such as AI provider API keys (`openssl rand -base64 32`). */
    SECRETS_ENCRYPTION_KEY: v.pipe(
        v.string(),
        v.check((value) => Buffer.from(value, "base64").length === 32, "SECRETS_ENCRYPTION_KEY must be 32 bytes encoded as base64"),
    ),

    /** Cloudflare Turnstile Keys */
    TURNSTILE_SITE_KEY: v.optional(v.string(), "1x00000000000000000000AA"),
    TURNSTILE_SECRET_KEY: v.optional(v.string(), "1x0000000000000000000000000000000AA"),

    BETTER_AUTH_URL: v.optional(v.string()),
    BETTER_AUTH_SECRET: v.optional(v.string()),

    TRUSTED_ORIGINS: v.pipe(
        v.optional(v.string(), "http://localhost:4000,http://localhost:9400"),
        v.transform((v) =>
            v
                ? v
                      .split(",")
                      .map((s) => s.trim().replace(/\/+$/, ""))
                      .filter(Boolean)
                : ["http://localhost:4000", "http://localhost:9400"],
        ),
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

    /**
     * Comma-separated IPv4/IPv6 CIDR blocks AI provider URLs must not resolve to. Empty by default,
     * so every destination is allowed; set it when untrusted users can add providers, e.g.
     * "169.254.0.0/16,fe80::/10" to keep cloud metadata endpoints out of reach.
     */
    AI_BLOCKED_CIDRS: v.pipe(
        v.optional(v.string(), ""),
        v.transform((value) =>
            value
                .split(",")
                .map((cidr) => cidr.trim())
                .filter(Boolean),
        ),
        v.check(
            (cidrs) => cidrs.every(isCidr),
            "AI_BLOCKED_CIDRS must be comma-separated IPv4 or IPv6 CIDR blocks, e.g. 10.0.0.0/8,fc00::/7",
        ),
    ),
});

export const env = v.parse(envSchema, process.env);
