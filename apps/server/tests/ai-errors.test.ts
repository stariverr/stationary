import { describe, expect, it } from "bun:test";
import { AiConfigurationError, AiProviderError, classifyAiError, getSafeAiErrorMessage } from "@/features/ai/errors";

describe("AI error classification", () => {
    it("does not retry authentication failures", () => {
        const result = classifyAiError(new AiProviderError("AUTHENTICATION", "invalid credentials", 401));

        expect(result).toEqual({ kind: "AUTHENTICATION", retryable: false });
    });

    it("retries rate limits and transient provider failures", () => {
        expect(classifyAiError(new AiProviderError("RATE_LIMITED", "slow down", 429))).toEqual({
            kind: "RATE_LIMITED",
            retryable: true,
        });
        expect(classifyAiError(new Error("fetch failed: socket closed"))).toEqual({
            kind: "TRANSIENT",
            retryable: true,
        });
    });

    it("retries connection failures reported only through system error codes", () => {
        const refused = Object.assign(new TypeError("Unable to connect. Is the computer able to access the url?"), { code: "ECONNREFUSED" });
        expect(classifyAiError(refused)).toEqual({ kind: "TRANSIENT", retryable: true });
        expect(classifyAiError(new Error("request failed", { cause: refused }))).toEqual({ kind: "TRANSIENT", retryable: true });
    });

    it("does not retry invalid configuration or unknown errors", () => {
        expect(classifyAiError(new AiConfigurationError("missing embedding provider"))).toEqual({
            kind: "CONFIGURATION",
            retryable: false,
        });
        expect(classifyAiError(new Error("invalid response shape"))).toEqual({
            kind: "UNKNOWN",
            retryable: false,
        });
    });

    it("uses provider status codes from SDK errors", () => {
        expect(classifyAiError({ statusCode: 503, message: "temporarily unavailable" })).toEqual({
            kind: "TRANSIENT",
            retryable: true,
        });
        expect(classifyAiError({ statusCode: 422, message: "bad input" })).toEqual({
            kind: "INVALID_REQUEST",
            retryable: false,
        });
    });

    it("redacts credentials from persisted error messages", () => {
        expect(getSafeAiErrorMessage("https://example.test?key=secret-value api_key=another-secret")).toContain(
            "key=[REDACTED]",
        );
        expect(getSafeAiErrorMessage('{"authorization":"Bearer secret-value"}')).toContain("[REDACTED]");
    });
});
