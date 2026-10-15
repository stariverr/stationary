import { afterEach, describe, expect, it } from "bun:test";
import { AiConfigurationError, AiProviderError } from "@/features/ai/errors";
import { parseModelCapabilities, type EmbeddingModelCapabilities } from "@/features/ai/model-schema";
import { DashScopeMultimodalEmbeddingProvider, GeminiVisualEmbeddingProvider } from "@/features/ai/providers";
import type { ResolvedModelConfig } from "@/features/ai/types";
import { computeEmbeddingSpaceId, estimateTokens, formatEmbeddingText, toEmbeddingResult } from "@/features/ai/utils";

const multimodalSpec: EmbeddingModelCapabilities = {
    dimension: 1024,
    mrl: true,
    maxInputTokens: 8192,
    multimodal: true,
    imageFormats: ["image/jpeg"],
};

function config(overrides: Partial<ResolvedModelConfig> = {}): ResolvedModelConfig {
    return {
        providerId: "provider-a",
        limits: { maxConcurrency: 4, requestsPerMinute: null },
        providerName: "Provider A",
        adapter: "dashscope-native",
        baseUrl: "https://dashscope.aliyuncs.com",
        apiKey: "secret-key",
        modelName: "qwen3-vl-embedding",
        category: "embedding",
        capabilities: multimodalSpec,
        ...overrides,
    };
}

type CapturedRequest = { url: string; headers: Headers; body: any };

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function mockFetch(responseBody: unknown): CapturedRequest[] {
    const requests: CapturedRequest[] = [];
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        requests.push({ url: request.url, headers: request.headers, body: await request.json() });
        return new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return requests;
}

const vector = (length: number) => Array.from({ length }, (_, index) => index / length);

describe("embedding model definitions", () => {
    it("only accepts indexable dimensions and defaults MRL to off", () => {
        const base = { maxInputTokens: 8192, multimodal: false };
        expect(parseModelCapabilities("embedding", { ...base, dimension: 4096 })).toBeNull();
        expect(parseModelCapabilities("embedding", { ...base, dimension: 1408 })).toBeNull();
        expect(parseModelCapabilities("embedding", { ...base, dimension: 1024 })).toMatchObject({ dimension: 1024, mrl: false });
    });
});

describe("embedding spaces", () => {
    it("do not depend on the provider connection", () => {
        const first = new DashScopeMultimodalEmbeddingProvider(config());
        const second = new DashScopeMultimodalEmbeddingProvider(config({ providerId: "provider-b", baseUrl: "https://other.example" }));
        expect(first.spaceId).toBe(second.spaceId);
        expect(first.spaceId).toBe(computeEmbeddingSpaceId("qwen3-vl-embedding", multimodalSpec));
    });

    it("change when the input template or dimension changes", () => {
        const plain = computeEmbeddingSpaceId("model", multimodalSpec);
        expect(computeEmbeddingSpaceId("model", { ...multimodalSpec, taskPrefixType: "gemini-asymmetric" })).not.toBe(plain);
        expect(computeEmbeddingSpaceId("model", { ...multimodalSpec, dimension: 768 })).not.toBe(plain);
    });

    it("reject vectors whose length differs from the model definition", () => {
        expect(() => toEmbeddingResult(vector(768), "model", multimodalSpec)).toThrow(AiConfigurationError);
        // A malformed vector may be a gateway hiccup, so it is a retryable provider error.
        expect(() => toEmbeddingResult(undefined, "model", multimodalSpec)).toThrow(AiProviderError);
        expect(toEmbeddingResult(vector(1024), "model", multimodalSpec)).toMatchObject({ dimension: 1024 });
    });
});

describe("DashScope multimodal embedding adapter", () => {
    it("sends contents and the requested MRL dimension", async () => {
        const requests = mockFetch({ output: { embeddings: [{ index: 0, embedding: vector(1024), type: "image" }] } });
        const provider = new DashScopeMultimodalEmbeddingProvider(config());

        const [result] = await provider.embedImages([{ imageBuffer: new Uint8Array([1, 2, 3]), mimeType: "image/jpeg" }]);

        expect(result?.dimension).toBe(1024);
        expect(requests[0]?.url).toBe(
            "https://dashscope.aliyuncs.com/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding",
        );
        expect(requests[0]?.body).toEqual({
            model: "qwen3-vl-embedding",
            input: { contents: [{ image: "data:image/jpeg;base64,AQID" }] },
            parameters: { dimension: 1024 },
        });
    });

    it("omits the dimension parameter for fixed-dimension models", async () => {
        const requests = mockFetch({ output: { embeddings: [{ index: 0, embedding: vector(1024), type: "text" }] } });
        const provider = new DashScopeMultimodalEmbeddingProvider(config({ capabilities: { ...multimodalSpec, mrl: false } }));

        await provider.embedText({ text: "cat", purpose: "QUERY" });

        expect(requests[0]?.body).toEqual({ model: "qwen3-vl-embedding", input: { contents: [{ text: "cat" }] } });
    });
});

describe("Gemini image embedding adapter", () => {
    it("batches images through batchEmbedContents with the key in a header", async () => {
        const requests = mockFetch({ embeddings: [{ values: vector(1024) }, { values: vector(1024) }] });
        const provider = new GeminiVisualEmbeddingProvider(
            config({ adapter: "gemini", baseUrl: "https://generativelanguage.googleapis.com", modelName: "gemini-embedding-2" }),
        );

        const results = await provider.embedImages([
            { imageBuffer: new Uint8Array([1]), mimeType: "image/png" },
            { imageBuffer: new Uint8Array([2]), mimeType: "image/jpeg" },
        ]);

        expect(results).toHaveLength(2);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents");
        expect(requests[0]?.headers.get("x-goog-api-key")).toBe("secret-key");
        expect(requests[0]?.body.requests).toHaveLength(2);
        expect(requests[0]?.body.requests[1]).toMatchObject({
            model: "models/gemini-embedding-2",
            content: { parts: [{ inlineData: { mimeType: "image/jpeg", data: "Ag==" } }] },
            outputDimensionality: 1024,
        });
    });

    it("rejects a response that does not match the batch", async () => {
        mockFetch({ embeddings: [{ values: vector(1024) }] });
        const provider = new GeminiVisualEmbeddingProvider(config({ adapter: "gemini", modelName: "gemini-embedding-2" }));
        await expect(
            provider.embedImages([
                { imageBuffer: new Uint8Array([1]), mimeType: "image/png" },
                { imageBuffer: new Uint8Array([2]), mimeType: "image/png" },
            ]),
        ).rejects.toBeInstanceOf(AiProviderError);
    });
});

describe("DashScope text batching", () => {
    it("sends several texts in one request and restores input order by index", async () => {
        const first = vector(1024);
        const second = vector(1024).map((value) => value + 1);
        const requests = mockFetch({
            output: {
                embeddings: [
                    { index: 1, embedding: second, type: "text" },
                    { index: 0, embedding: first, type: "text" },
                ],
            },
        });
        const provider = new DashScopeMultimodalEmbeddingProvider(config());

        const results = await provider.embedTexts([
            { text: "a", purpose: "DOCUMENT" },
            { text: "b", purpose: "DOCUMENT" },
        ]);

        expect(requests[0]?.body.input).toEqual({ contents: [{ text: "a" }, { text: "b" }] });
        expect(results.map((result) => result.embedding[0])).toEqual([first[0], second[0]]);
    });
});

describe("embedding input limits", () => {
    const limited: EmbeddingModelCapabilities = { dimension: 256, mrl: false, maxInputTokens: 100, multimodal: false };

    it("keeps short inputs intact", () => {
        expect(formatEmbeddingText({ text: "a short caption", purpose: "DOCUMENT" }, limited)).toBe("a short caption");
    });

    it("cuts long inputs from the end to fit the model's token limit", () => {
        const text = `Media Title: cat\nOCR: ${"文".repeat(500)}`;
        const formatted = formatEmbeddingText({ text, purpose: "DOCUMENT" }, limited);
        expect(formatted.startsWith("Media Title: cat")).toBe(true);
        expect(estimateTokens(formatted)).toBeLessThanOrEqual(90);
    });

    it("reserves room for task prefixes", () => {
        const spec: EmbeddingModelCapabilities = { ...limited, taskPrefixType: "gemini-asymmetric" };
        const formatted = formatEmbeddingText({ text: "x".repeat(1_000), purpose: "QUERY" }, spec);
        expect(formatted.startsWith("task: search result | query: x")).toBe(true);
        expect(estimateTokens(formatted)).toBeLessThanOrEqual(90);
    });
});
