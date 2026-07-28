import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value === null || typeof value !== "object") return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([, item]) => item !== undefined)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, canonicalize(item)]),
    );
}

/**
 * Generate a deterministic, fixed-length idempotency key with a domain prefix and SHA-256 hash.
 * Prevents key length bloat when handling large lists of IDs while guaranteeing exact duplicate filtering.
 *
 * @param prefix Category or task domain prefix (e.g. 'ai_enrich', 'avatar_copy', 'post_process')
 * @param payload Object, array, or string payload to hash deterministically
 */
export function createIdempotencyKey(prefix: string, payload: unknown): string {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) throw new Error("Idempotency key prefix must not be empty");

    const raw = typeof payload === "string" ? payload : (JSON.stringify(canonicalize(payload)) ?? String(payload));
    const hash = createHash("sha256").update(raw).digest("hex").slice(0, 32);
    return `${normalizedPrefix}:${hash}`;
}
