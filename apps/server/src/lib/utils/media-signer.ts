import { createHmac, timingSafeEqual } from "crypto";

import { env } from "@/global/env";

const DEFAULT_TTL_SECONDS = 14400; // 4 hours

/**
 * Generates an HMAC-SHA256 signature for media streaming access.
 */
export function createMediaSignature(
    mediaId: string,
    trackId?: string | null,
    expiresInSeconds: number = DEFAULT_TTL_SECONDS,
): { expires: number; sig: string; queryParams: string } {
    const expires = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000) + expiresInSeconds;
    const sig = computeHmac(mediaId, trackId, expires);
    return {
        expires,
        sig,
        queryParams: `expires=${expires}&sig=${sig}`,
    };
}

/**
 * Verifies if an incoming request has a valid and non-expired media signature.
 */
export function verifyMediaSignature(
    mediaId: string,
    trackId: string | null | undefined,
    expires: number | string | undefined,
    sig: string | undefined,
): boolean {
    if (!expires || !sig) return false;

    const expiresNum = typeof expires === "number" ? expires : parseInt(expires, 10);
    if (isNaN(expiresNum)) return false;

    const now = Math.floor(Temporal.Now.instant().epochMilliseconds / 1000);
    if (now > expiresNum) return false;

    if (trackId) {
        const expectedTrackSig = computeHmac(mediaId, trackId, expiresNum);
        if (safeCompare(sig, expectedTrackSig)) return true;
    }

    const expectedMediaSig = computeHmac(mediaId, null, expiresNum);
    return safeCompare(sig, expectedMediaSig);
}

function computeHmac(mediaId: string, trackId: string | null | undefined, expires: number): string {
    const payload = trackId ? `${mediaId}:${trackId}:${expires}` : `${mediaId}:${expires}`;
    return createHmac("sha256", env.AUTH_SECRET).update(payload).digest("hex");
}

function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return timingSafeEqual(Buffer.from(a, "utf-8"), Buffer.from(b, "utf-8"));
    } catch {
        return false;
    }
}
