import { randomUUID } from "node:crypto";
import { AiThrottledError, classifyAiError } from "./errors";

/** Per-provider request limits, configured on the provider connection. */
export interface ProviderLimits {
    maxConcurrency: number;
    /** null means the provider imposes no request-per-minute limit we need to respect. */
    requestsPerMinute: number | null;
}

/** Shared limiter state; every server instance must see the same counters. */
export interface RateLimitStore {
    /** Reserves a request slot. Returns 0 when granted, otherwise milliseconds to wait. */
    acquire(providerId: string, limits: ProviderLimits, leaseId: string, leaseTtlMs: number): Promise<number>;
    release(providerId: string, leaseId: string): Promise<void>;
    /** Blocks the provider for `ms`, extending but never shortening an existing cool-down. */
    coolDown(providerId: string, ms: number): Promise<void>;
}

/** How long a granted slot stays reserved if its holder crashes before releasing it. */
const LEASE_TTL_MS = 10 * 60 * 1000;
/** Cool-down after a 429 without Retry-After. */
const DEFAULT_COOL_DOWN_MS = 30_000;
/** Suggested wait when every concurrency slot is taken; slots free up as calls finish. */
const CONCURRENCY_WAIT_MS = 2_000;

const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local rpm = tonumber(ARGV[2])
local maxConcurrency = tonumber(ARGV[3])
local cooldown = redis.call('pttl', KEYS[1])
if cooldown > 0 then return cooldown end
redis.call('zremrangebyscore', KEYS[3], '-inf', now)
if redis.call('zcard', KEYS[3]) >= maxConcurrency then return tonumber(ARGV[6]) end
if rpm > 0 then
    local used = tonumber(redis.call('get', KEYS[2]) or '0')
    if used >= rpm then
        local ttl = redis.call('pttl', KEYS[2])
        if ttl < 0 then ttl = 1000 end
        return ttl
    end
    if redis.call('incr', KEYS[2]) == 1 then redis.call('pexpire', KEYS[2], 60000) end
end
redis.call('zadd', KEYS[3], now + tonumber(ARGV[5]), ARGV[4])
redis.call('pexpire', KEYS[3], tonumber(ARGV[5]))
return 0`;

const COOL_DOWN_SCRIPT = `
local ms = tonumber(ARGV[1])
if redis.call('pttl', KEYS[1]) < ms then redis.call('set', KEYS[1], '1', 'PX', ms) end
return 0`;

const keys = (providerId: string) => ({
    coolDown: `ai:limit:${providerId}:cooldown`,
    window: `ai:limit:${providerId}:rpm`,
    inFlight: `ai:limit:${providerId}:inflight`,
});

export function createRedisRateLimitStore(redis: {
    evalScript(script: string, keys: string[], args: string[]): Promise<unknown>;
}): RateLimitStore {
    return {
        async acquire(providerId, limits, leaseId, leaseTtlMs) {
            const k = keys(providerId);
            const wait = await redis.evalScript(
                ACQUIRE_SCRIPT,
                [k.coolDown, k.window, k.inFlight],
                [
                    String(Date.now()),
                    String(limits.requestsPerMinute ?? 0),
                    String(limits.maxConcurrency),
                    leaseId,
                    String(leaseTtlMs),
                    String(CONCURRENCY_WAIT_MS),
                ],
            );
            return Number(wait) || 0;
        },
        async release(providerId, leaseId) {
            await redis.evalScript("return redis.call('zrem', KEYS[1], ARGV[1])", [keys(providerId).inFlight], [leaseId]);
        },
        async coolDown(providerId, ms) {
            await redis.evalScript(COOL_DOWN_SCRIPT, [keys(providerId).coolDown], [String(Math.ceil(ms))]);
        },
    };
}

export interface RunLimitedOptions {
    /** How long the caller may wait for capacity. 0 makes throttling fail fast with AiThrottledError. */
    maxWaitMs?: number;
    signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(signal.reason);
            },
            { once: true },
        );
    });
}

export interface ProviderLimiter {
    run<T>(providerId: string, limits: ProviderLimits, call: () => Promise<T>, options?: RunLimitedOptions): Promise<T>;
}

/**
 * Wraps every provider call: waits for (or reports) capacity, and turns a provider 429 into a
 * shared cool-down so other workers stop calling the provider until Retry-After has passed.
 */
export function createProviderLimiter(store: RateLimitStore): ProviderLimiter {
    return {
        async run(providerId, limits, call, options = {}) {
            const deadline = Date.now() + (options.maxWaitMs ?? 0);
            const leaseId = randomUUID();
            for (;;) {
                const wait = await store.acquire(providerId, limits, leaseId, LEASE_TTL_MS);
                if (wait <= 0) break;
                if (Date.now() + wait > deadline) throw new AiThrottledError(providerId, wait);
                await sleep(wait, options.signal);
            }

            try {
                return await call();
            } catch (error) {
                const classification = classifyAiError(error);
                if (classification.kind === "RATE_LIMITED") {
                    await store.coolDown(providerId, classification.retryAfterMs ?? DEFAULT_COOL_DOWN_MS);
                }
                throw error;
            } finally {
                await store.release(providerId, leaseId).catch((error: unknown) => {
                    console.warn(`[AI LIMIT] Failed to release a slot of provider ${providerId}; it expires on its own.`, error);
                });
            }
        },
    };
}
