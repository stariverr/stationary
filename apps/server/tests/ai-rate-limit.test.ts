import { describe, expect, it } from "bun:test";
import { AiProviderError, AiThrottledError, classifyAiError, parseRetryAfterHeader } from "@/features/ai/errors";
import { createProviderLimiter, type ProviderLimits, type RateLimitStore } from "@/features/ai/rate-limit";
import { throttledDelaySeconds } from "@/infra/jobs/policy";

const limits: ProviderLimits = { maxConcurrency: 1, requestsPerMinute: null };

/** In-memory stand-in for the Redis store: one concurrency slot plus a cool-down. */
function memoryStore() {
    const inFlight = new Set<string>();
    const state = { coolDownMs: 0, coolDowns: [] as number[], releases: 0 };
    const store: RateLimitStore = {
        async acquire(_providerId, providerLimits, leaseId) {
            if (state.coolDownMs > 0) return state.coolDownMs;
            if (inFlight.size >= providerLimits.maxConcurrency) return 2_000;
            inFlight.add(leaseId);
            return 0;
        },
        async release(_providerId, leaseId) {
            inFlight.delete(leaseId);
            state.releases += 1;
        },
        async coolDown(_providerId, ms) {
            state.coolDownMs = Math.max(state.coolDownMs, ms);
            state.coolDowns.push(ms);
        },
    };
    return { store, state };
}

describe("provider limiter", () => {
    it("fails fast for background callers when no slot is free", async () => {
        const { store } = memoryStore();
        const limiter = createProviderLimiter(store);
        let releaseFirst!: () => void;
        const first = limiter.run("p", limits, () => new Promise<string>((resolve) => (releaseFirst = () => resolve("first"))));

        const second = limiter.run("p", limits, async () => "second");
        await expect(second).rejects.toBeInstanceOf(AiThrottledError);
        await expect(second).rejects.toMatchObject({ retryAfterMs: 2_000 });

        releaseFirst();
        expect(await first).toBe("first");
        expect(await limiter.run("p", limits, async () => "third")).toBe("third");
    });

    it("cools the provider down for its Retry-After after a 429 and always releases the slot", async () => {
        const { store, state } = memoryStore();
        const limiter = createProviderLimiter(store);

        const call = limiter.run("p", limits, async () => {
            throw new AiProviderError("RATE_LIMITED", "slow down", 429, 12_000);
        });
        await expect(call).rejects.toBeInstanceOf(AiProviderError);

        expect(state.coolDowns).toEqual([12_000]);
        expect(state.releases).toBe(1);
        await expect(limiter.run("p", limits, async () => "blocked")).rejects.toMatchObject({ retryAfterMs: 12_000 });
    });

    it("does not cool down on other provider errors", async () => {
        const { store, state } = memoryStore();
        const limiter = createProviderLimiter(store);
        await expect(
            limiter.run("p", limits, async () => {
                throw new AiProviderError("TRANSIENT", "bad gateway", 502);
            }),
        ).rejects.toBeInstanceOf(AiProviderError);
        expect(state.coolDowns).toEqual([]);
    });
});

describe("retry timing", () => {
    it("classifies throttling and Retry-After from provider and SDK errors", () => {
        expect(classifyAiError(new AiThrottledError("p", 5_000))).toEqual({ kind: "THROTTLED", retryable: true, retryAfterMs: 5_000 });
        expect(classifyAiError(new AiProviderError("RATE_LIMITED", "slow down", 429, 7_000))).toMatchObject({ retryAfterMs: 7_000 });
        // AI SDK APICallError: retryable flag plus raw response headers.
        expect(
            classifyAiError({ statusCode: 429, isRetryable: true, responseHeaders: { "Retry-After": "20" }, message: "Too Many Requests" }),
        ).toEqual({ kind: "RATE_LIMITED", retryable: true, retryAfterMs: 20_000 });
    });

    it("parses Retry-After seconds and HTTP dates", () => {
        expect(parseRetryAfterHeader("3")).toBe(3_000);
        expect(parseRetryAfterHeader("Thu, 01 Jan 1970 00:00:10 GMT", 4_000)).toBe(6_000);
        expect(parseRetryAfterHeader("soon")).toBeUndefined();
    });

    it("spreads throttled units across the wait window", () => {
        expect(throttledDelaySeconds(10, () => 0)).toBe(10);
        expect(throttledDelaySeconds(10, () => 1)).toBe(15);
        expect(throttledDelaySeconds(undefined, () => 0)).toBe(1);
        expect(throttledDelaySeconds(10_000, () => 0)).toBe(300);
    });
});
