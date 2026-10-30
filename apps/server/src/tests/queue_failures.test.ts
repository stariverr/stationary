import { describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaType } from "@/db/schema";
import { AiProviderError, AiThrottledError } from "@/features/ai/errors";
import { aiErrorResult } from "@/features/ai/pipeline-result";
import { createProviderLimiter, type RateLimitStore } from "@/features/ai/rate-limit";
import { Quality } from "@/lib/types";
import { UndecodableSourceError, renderCoverFrame } from "@/lib/utils/cover_renderer";
import { DownloadStatusError } from "@/lib/utils/media";

describe("aiErrorResult", () => {
    test("rejects only errors about the input", () => {
        expect(aiErrorResult(new AiProviderError("INVALID_REQUEST", "bad image")).kind).toBe("rejected");
        expect(aiErrorResult(new AiProviderError("UNSUPPORTED", "not an image")).kind).toBe("rejected");

        for (const kind of ["AUTHENTICATION", "NOT_FOUND", "RATE_LIMITED", "TRANSIENT", "TIMEOUT", "UNKNOWN"] as const) {
            expect(aiErrorResult(new AiProviderError(kind, "provider failed")).kind).toBe("retry");
        }
    });

    test("retries an error nobody recognizes", () => {
        expect(aiErrorResult(new Error("something odd"))).toMatchObject({ kind: "retry", errorKind: "UNKNOWN" });
    });

    test("postpones a throttled run", () => {
        expect(aiErrorResult(new AiThrottledError("provider", 1_000)).kind).toBe("deferred");
    });
});

describe("DownloadStatusError", () => {
    test("blames the URL for client errors, except those that ask to try again", () => {
        for (const status of [400, 403, 404, 410]) expect(new DownloadStatusError(status, "https://a").rejected).toBe(true);
        for (const status of [408, 425, 429, 500, 503]) expect(new DownloadStatusError(status, "https://a").rejected).toBe(false);
    });
});

describe("createProviderLimiter", () => {
    function setup() {
        const store: RateLimitStore = {
            acquire: mock(async () => 0),
            release: mock(async () => undefined),
            coolDown: mock(async () => undefined),
            reportFailure: mock(async () => 0),
            reportSuccess: mock(async () => undefined),
            reset: mock(async () => undefined),
            blockedMs: mock(async () => 0),
        };
        const limits = { maxConcurrency: 1, requestsPerMinute: null };
        const run = (call: () => Promise<string>) => createProviderLimiter(store).run("provider", limits, call);
        return { store, run };
    }

    test("forgets failures after a success", async () => {
        const { store, run } = setup();
        expect(await run(async () => "ok")).toBe("ok");
        expect(store.reportSuccess).toHaveBeenCalledTimes(1);
        expect(store.reportFailure).not.toHaveBeenCalled();
    });

    test("counts failures that point at the provider", async () => {
        const { store, run } = setup();
        for (const error of [new AiProviderError("AUTHENTICATION", "no"), new AiProviderError("TRANSIENT", "no"), new Error("odd")]) {
            await expect(run(() => Promise.reject(error))).rejects.toBe(error);
        }
        expect(store.reportFailure).toHaveBeenCalledTimes(3);
    });

    test("does not count bad input, a provider that is only busy, or a cancelled call", async () => {
        const { store, run } = setup();
        const cancelled = new DOMException("stopped", "AbortError");
        for (const error of [new AiProviderError("INVALID_REQUEST", "no"), new AiProviderError("RATE_LIMITED", "no"), cancelled]) {
            await expect(run(() => Promise.reject(error))).rejects.toBe(error);
        }
        expect(store.reportFailure).not.toHaveBeenCalled();
        expect(store.coolDown).toHaveBeenCalledTimes(1);
    });

    test("keeps a provider's answer when the limiter state cannot be updated", async () => {
        const { store, run } = setup();
        store.reportSuccess = mock(() => Promise.reject(new Error("redis is down")));
        expect(await run(async () => "ok")).toBe("ok");
    });
});

describe("renderCoverFrame", () => {
    test.skipIf(!Bun.which("ffmpeg"))("reports a source FFmpeg cannot decode", async () => {
        const path = join(tmpdir(), `undecodable-${crypto.randomUUID()}.mp4`);
        await Bun.write(path, crypto.getRandomValues(new Uint8Array(4096)));
        await expect(renderCoverFrame(path, MediaType.VIDEO, Quality.LOW)).rejects.toBeInstanceOf(UndecodableSourceError);
        await Bun.file(path).delete();
    });
});
