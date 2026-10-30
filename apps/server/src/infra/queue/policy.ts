export const LEASE_SECONDS = 60;
export const HEARTBEAT_INTERVAL_MS = 20_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const MAX_RETRY_DELAY_SECONDS = 300;
/** Subjects per library scan step. */
export const SCAN_PAGE_SIZE = 200;
/** How often every library is rescanned to catch changes no writer reported. */
export const PATROL_INTERVAL_MS = 60 * 60_000;

/** Writers reporting a change go before work found by library scans, so new content is not starved by backfills. */
export const Priority = {
    CHANGE: 10,
    BACKFILL: 0,
} as const;

export function retryDelaySeconds(attemptCount: number, random = Math.random): number {
    const normalizedAttempt = Math.max(1, Math.trunc(attemptCount));
    const exponentialDelay = Math.min(MAX_RETRY_DELAY_SECONDS, 5 * 4 ** (normalizedAttempt - 1));
    const jitterMultiplier = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
    return Math.min(MAX_RETRY_DELAY_SECONDS, Math.max(1, Math.round(exponentialDelay * jitterMultiplier)));
}

/** Spreads runs held back by a rate limit over the wait window so they do not all reclaim capacity at once. */
export function throttledDelaySeconds(retryAfterSeconds: number | undefined, random = Math.random): number {
    const base = Math.max(1, retryAfterSeconds ?? 1);
    const jitterMultiplier = 1 + Math.min(1, Math.max(0, random())) * 0.5;
    return Math.min(MAX_RETRY_DELAY_SECONDS, Math.ceil(base * jitterMultiplier));
}
