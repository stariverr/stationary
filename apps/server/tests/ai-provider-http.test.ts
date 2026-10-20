import { describe, expect, it } from "bun:test";
import { postJson } from "@/features/ai/providers/http";
import { AiProviderError, classifyAiError } from "@/features/ai/errors";
import { withTimeout } from "@/features/ai/utils";

describe("AI provider HTTP client", () => {
    it("normalizes status errors and removes credentials from the message", async () => {
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            new Response(JSON.stringify({ error: "invalid key secret-token" }), {
                status: 401,
                statusText: "Unauthorized",
                headers: { "content-type": "application/json" },
            })) as unknown as typeof fetch;

        try {
            let error: unknown;
            try {
                await postJson("https://provider.example/v1/embed?key=secret-token", {
                    headers: { Authorization: "Bearer secret-token" },
                    json: { input: "test" },
                });
            } catch (value) {
                error = value;
            }

            expect(error).toBeInstanceOf(AiProviderError);
            const providerError = error as AiProviderError;
            expect(providerError).toMatchObject({ kind: "AUTHENTICATION", status: 401 });
            expect(providerError.message).not.toContain("secret-token");
            expect(providerError.message).toContain("[REDACTED]");
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it("tells a call timeout apart from cancellation", async () => {
        const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
        const url = `http://localhost:${server.port}/v1/embed`;
        const failure = (signal: AbortSignal) => postJson(url, { json: {}, signal }).then(() => null, (error: unknown) => error);
        try {
            expect(classifyAiError(await failure(withTimeout(undefined, 50)))).toMatchObject({ kind: "TIMEOUT", retryable: true });
            const controller = new AbortController();
            setTimeout(() => controller.abort(), 50);
            expect(classifyAiError(await failure(withTimeout(controller.signal, 5_000)))).toMatchObject({ kind: "CANCELLED", retryable: false });
        } finally {
            server.stop(true);
        }
    });
});
