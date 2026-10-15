import { describe, expect, it } from "bun:test";
import { postJson } from "@/features/ai/providers/http";
import { AiProviderError } from "@/features/ai/errors";

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
});
