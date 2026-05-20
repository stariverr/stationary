import { db } from "@/global/db";
import { ExternalApiToken } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";

export const ApiTokenService = {
    /**
     * Generates a new Stripe/GitHub style structured API key, hashes it,
     * saves it to the database, and returns the raw key to be shown once.
     */
    async generateToken(
        ownerId: string,
        name: string,
        libraryId?: string | null,
        expiresInSeconds?: number | null
    ) {
        const prefix = "st";
        const randomBody = randomBytes(20).toString("hex"); // 40 hex characters
        const checksum = createHash("sha256").update(randomBody).digest("hex").substring(0, 6); // 6 hex characters
        const rawToken = `${prefix}_${randomBody}${checksum}`;

        // Compute SHA-256 hash of the entire token for database lookup
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        const expiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;

        const results = await db
            .insert(ExternalApiToken)
            .values({
                name,
                token_hash: tokenHash,
                prefix,
                first_four: randomBody.substring(0, 4),
                last_four: rawToken.slice(-4),
                owner_id: ownerId,
                library_id: libraryId || null,
                expires_at: expiresAt,
            })
            .returning();

        return {
            rawToken,
            token: results[0],
        };
    },

    /**
     * Verifies the token structure and checks the DB for an active match.
     * Returns the token record if valid, otherwise null.
     */
    async verifyToken(rawToken: string) {
        // 1. Fast Fail: Verify checksum structure before hitting the DB
        const parts = rawToken.split("_");
        if (parts.length !== 2) return null;

        const [prefix, bodyAndChecksum] = parts;
        if (prefix !== "st" || bodyAndChecksum.length !== 46) return null; // 40 chars body + 6 chars checksum

        const body = bodyAndChecksum.substring(0, 40);
        const checksum = bodyAndChecksum.substring(40);
        const expectedChecksum = createHash("sha256").update(body).digest("hex").substring(0, 6);

        if (checksum !== expectedChecksum) return null;

        // 2. Compute token hash
        const tokenHash = createHash("sha256").update(rawToken).digest("hex");

        // 3. Look up in the database
        const tokens = await db
            .select()
            .from(ExternalApiToken)
            .where(
                and(
                    eq(ExternalApiToken.token_hash, tokenHash),
                    isNull(ExternalApiToken.revoked_at)
                )
            )
            .limit(1);

        const token = tokens[0];
        if (!token) return null;

        // 4. Expiration check
        if (token.expires_at && token.expires_at < new Date()) {
            return null;
        }

        // 5. Asynchronously update last_used_at
        db.update(ExternalApiToken)
            .set({ last_used_at: new Date() })
            .where(eq(ExternalApiToken.id, token.id))
            .execute()
            .catch((err) => console.error("[ApiTokenService] Failed to update last_used_at:", err));

        return token;
    },

    /**
     * Lists active (non-revoked) tokens belonging to the owner.
     */
    async listTokens(ownerId: string) {
        return db
            .select({
                id: ExternalApiToken.id,
                name: ExternalApiToken.name,
                prefix: ExternalApiToken.prefix,
                first_four: ExternalApiToken.first_four,
                last_four: ExternalApiToken.last_four,
                library_id: ExternalApiToken.library_id,
                last_used_at: ExternalApiToken.last_used_at,
                expires_at: ExternalApiToken.expires_at,
                create_time: ExternalApiToken.create_time,
            })
            .from(ExternalApiToken)
            .where(
                and(
                    eq(ExternalApiToken.owner_id, ownerId),
                    isNull(ExternalApiToken.revoked_at)
                )
            );
    },

    /**
     * Revokes a token by setting revoked_at.
     */
    async revokeToken(tokenId: string, ownerId: string) {
        const results = await db
            .update(ExternalApiToken)
            .set({ revoked_at: new Date() })
            .where(
                and(
                    eq(ExternalApiToken.id, tokenId),
                    eq(ExternalApiToken.owner_id, ownerId)
                )
            )
            .returning();

        return results.length > 0;
    },
};
