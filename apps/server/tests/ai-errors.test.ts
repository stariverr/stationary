import { describe, expect, it } from "bun:test";
import { AiConfigurationError, AiProviderError, classifyAiError, getSafeAiErrorMessage } from "@/features/ai/errors";

describe("AI error classification", () => {
    it("classifies authentication failures", () => {
        const result = classifyAiError(new AiProviderError("AUTHENTICATION", "invalid credentials", 401));

        expect(result).toEqual({ kind: "AUTHENTICATION" });
    });

    it("classifies rate limits and transient provider failures", () => {
        expect(classifyAiError(new AiProviderError("RATE_LIMITED", "slow down", 429))).toEqual({
            kind: "RATE_LIMITED",
        });
        expect(classifyAiError(new Error("fetch failed: socket closed"))).toEqual({
            kind: "TRANSIENT",
        });
    });

    it("classifies connection failures reported only through system error codes", () => {
        const refused = Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), {
            code: "ECONNREFUSED",
        });
        expect(classifyAiError(refused)).toEqual({ kind: "TRANSIENT" });
        expect(classifyAiError(new Error("request failed", { cause: refused }))).toEqual({ kind: "TRANSIENT" });
    });

    it("treats only abort signals as cancellation, not messages that mention it", () => {
        expect(classifyAiError(new DOMException("The operation was aborted.", "AbortError"))).toEqual({ kind: "CANCELLED" });
        // The AI SDK's RetryError wraps the final attempt's error in `lastError`.
        const retryError = Object.assign(new Error("Failed after 3 attempts."), { lastError: new DOMException("aborted", "AbortError") });
        expect(classifyAiError(retryError)).toEqual({ kind: "CANCELLED" });
        expect(classifyAiError(new DOMException("signal timed out", "TimeoutError"))).toEqual({ kind: "TIMEOUT" });
        expect(classifyAiError(new Error("Request cancelled by upstream; aborting"))).toEqual({ kind: "UNKNOWN" });
    });

    it("classifies malformed provider responses", () => {
        expect(classifyAiError(new AiProviderError("TRANSIENT", "Model 'm' returned 1 embeddings for 2 inputs."))).toEqual({
            kind: "TRANSIENT",
        });
    });

    it("classifies invalid configuration and unknown errors", () => {
        expect(classifyAiError(new AiConfigurationError("missing embedding provider"))).toEqual({
            kind: "CONFIGURATION",
        });
        expect(classifyAiError(new Error("invalid response shape"))).toEqual({
            kind: "UNKNOWN",
        });
    });

    it("uses provider status codes from SDK errors", () => {
        expect(classifyAiError({ statusCode: 503, message: "temporarily unavailable" })).toEqual({
            kind: "TRANSIENT",
        });
        expect(classifyAiError({ statusCode: 422, message: "bad input" })).toEqual({
            kind: "INVALID_REQUEST",
        });
    });

    it("redacts credentials from persisted error messages", () => {
        expect(getSafeAiErrorMessage("https://example.test?key=secret-value api_key=another-secret")).toContain("key=[REDACTED]");
        expect(getSafeAiErrorMessage('{"authorization":"Bearer secret-value"}')).toContain("[REDACTED]");
    });
});
