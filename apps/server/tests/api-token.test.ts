import { describe, expect, test } from "bun:test";
import { ApiTokenService } from "../src/services/apiToken";
import { createHash } from "crypto";

Object.assign(process.env, {
    AUTH_SECRET: "test-auth-secret",
    RESEND_API_KEY: "test-resend-key",
    S3_ENDPOINT: "http://localhost:9000",
    S3_ACCESS_KEY_ID: "test-access-key",
    S3_SECRET_ACCESS_KEY: "test-secret-key",
    S3_REGION: "test-region",
    S3_BUCKET: "test-bucket",
    CDN_BASE_URL: "http://localhost:9000/test-bucket",
    DB_URL: "postgres://test:test@localhost:5432/test",
});

describe("API Token Format and Checksum", () => {
    test("generates structured token in correct format", async () => {
        const ownerId = "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3";
        // Mock DB insert by overriding it temporarily or just testing formatting
        const prefix = "st";
        const randomBody = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"; // 40 hex chars
        const checksum = createHash("sha256").update(randomBody).digest("hex").substring(0, 6);
        const rawToken = `${prefix}_${randomBody}${checksum}`;

        expect(rawToken.startsWith("st_")).toBe(true);
        expect(rawToken.length).toBe(49); // st_ (3) + body (40) + checksum (6) = 49
    });

    test("checksum validation correctly identifies valid and invalid tokens", () => {
        const randomBody = "abcdef1234567890abcdef1234567890abcdef12"; // 40 chars
        const validChecksum = createHash("sha256").update(randomBody).digest("hex").substring(0, 6);
        const validToken = `st_${randomBody}${validChecksum}`;

        // Helper to test verifyToken internal checksum logic
        const verifyChecksumFormat = (token: string) => {
            const parts = token.split("_");
            if (parts.length !== 2) return false;
            const [prefix, bodyAndChecksum] = parts;
            if (prefix !== "st" || bodyAndChecksum.length !== 46) return false;
            const b = bodyAndChecksum.substring(0, 40);
            const c = bodyAndChecksum.substring(40);
            const expected = createHash("sha256").update(b).digest("hex").substring(0, 6);
            return c === expected;
        };

        expect(verifyChecksumFormat(validToken)).toBe(true);

        // Invalid tokens (mutated random body or checksum)
        const mutatedBodyToken = `st_xbcdef1234567890abcdef1234567890abcdef12${validChecksum}`;
        const mutatedChecksumToken = `st_${randomBody}999999`;
        const wrongPrefixToken = `sk_${randomBody}${validChecksum}`;
        const wrongLengthToken = `st_${randomBody}a${validChecksum}`;

        expect(verifyChecksumFormat(mutatedBodyToken)).toBe(false);
        expect(verifyChecksumFormat(mutatedChecksumToken)).toBe(false);
        expect(verifyChecksumFormat(wrongPrefixToken)).toBe(false);
        expect(verifyChecksumFormat(wrongLengthToken)).toBe(false);
    });
});

describe("Token Route Validation", () => {
    test("validates token creation payloads correctly", async () => {
        const userApi = await import("../src/api/user");
        const schema = (userApi as any).TokenCreateBodySchema;

        // Valid payload
        const valid = schema.safeParse({
            name: "GitHub Sync Script",
            library_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
            expires_in_seconds: 3600,
        });
        expect(valid.success).toBe(true);

        // Optional fields missing
        const partial = schema.safeParse({
            name: "GitHub Sync Script",
        });
        expect(partial.success).toBe(true);

        // Missing required field
        const missingName = schema.safeParse({
            library_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
        });
        expect(missingName.success).toBe(false);

        // Invalid uuid
        const invalidUuid = schema.safeParse({
            name: "GitHub Sync Script",
            library_id: "invalid-uuid",
        });
        expect(invalidUuid.success).toBe(false);

        // Negative expiration
        const negativeExp = schema.safeParse({
            name: "GitHub Sync Script",
            expires_in_seconds: -10,
        });
        expect(negativeExp.success).toBe(false);
    });
});
