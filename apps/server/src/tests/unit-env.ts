const defaults: Record<string, string> = {
    SERVER_ENV: "test",
    DB_URL: "postgresql://postgres:postgres@127.0.0.1:5432/stationary_test",
    REDIS_URL: "redis://127.0.0.1:6379",
    RESEND_API_KEY: "re_test",
    RESEND_EMAIL_SENDER: "test@example.com",
    AUTH_SECRET: "test-auth-secret-min-32-characters-long",
    SECRETS_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    S3_ENDPOINT: "https://s3.example.com",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    S3_REGION: "auto",
    S3_BUCKET: "stationary-test",
    CDN_BASE_URL: "https://cdn.example.com",
};

for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
}
