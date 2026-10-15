import { afterEach, describe, expect, it } from "bun:test";
import type { AiModelCapabilities, AiModelCategory } from "@/features/ai/model-schema";
import { probeModel } from "@/features/ai/probe";
import type { ResolvedModelConfig } from "@/features/ai/types";

function config(category: AiModelCategory, capabilities: AiModelCapabilities): ResolvedModelConfig {
    return {
        providerId: "provider-a",
        limits: { maxConcurrency: 4, requestsPerMinute: null },
        providerName: "Gateway",
        adapter: "openai-compatible",
        baseUrl: "https://gateway.test/v1",
        apiKey: "secret-key",
        modelName: "some-model",
        category,
        capabilities,
    };
}

/** How the fake OpenAI-compatible gateway behaves. */
interface Gateway {
    seesImages?: boolean;
    structuredOutput?: boolean;
    dimension?: number;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function chatCompletion(content: string) {
    return json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "some-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

function mockGateway(gateway: Gateway) {
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const body = (await request.json()) as any;
        const path = new URL(request.url).pathname;

        if (path.endsWith("/chat/completions")) {
            if (body.response_format) {
                return gateway.structuredOutput ? chatCompletion('{"sum":5}') : json({ error: { message: "response_format is not supported" } }, 400);
            }
            const hasImage = body.messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url"));
            return chatCompletion(hasImage && gateway.seesImages ? "red" : "I can't see any image.");
        }
        if (path.endsWith("/embeddings")) {
            const embedding = Array.from({ length: gateway.dimension ?? 0 }, (_, index) => index);
            return json({ object: "list", data: [{ object: "embedding", index: 0, embedding }], model: "some-model", usage: { prompt_tokens: 1, total_tokens: 1 } });
        }
        if (path.endsWith("/rerank")) {
            return json({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] });
        }
        return json({ error: { message: "not found" } }, 404);
    }) as unknown as typeof fetch;
}

const visionSpec: AiModelCapabilities = {
    contextWindow: 128000,
    inputModalities: ["text", "image"],
    imageFormats: ["image/png"],
    structuredOutput: true,
};

describe("model probes", () => {
    it("pass when the gateway serves what the definition claims", async () => {
        mockGateway({ seesImages: true, structuredOutput: true });
        expect(await probeModel(config("generation", visionSpec))).toEqual([
            { check: "imageInput", ok: true },
            { check: "structuredOutput", ok: true },
        ]);
    });

    it("catch gateways that drop images or reject JSON schemas", async () => {
        mockGateway({ seesImages: false, structuredOutput: false });
        const [image, structured] = await probeModel(config("generation", visionSpec));
        expect(image).toMatchObject({ check: "imageInput", ok: false });
        expect(image?.message).toContain("can't see");
        expect(structured).toMatchObject({ check: "structuredOutput", ok: false });
    });

    it("only run the checks the definition claims", async () => {
        mockGateway({ seesImages: true, structuredOutput: true });
        const results = await probeModel(config("generation", { contextWindow: 8000, inputModalities: ["text"], structuredOutput: false }));
        expect(results).toEqual([]);
    });

    it("compare embedding sizes with the definition", async () => {
        const spec: AiModelCapabilities = { dimension: 1024, mrl: false, maxInputTokens: 8192, multimodal: false };
        mockGateway({ dimension: 1024 });
        expect(await probeModel(config("embedding", spec))).toEqual([{ check: "embedding", ok: true }]);
        mockGateway({ dimension: 768 });
        const [result] = await probeModel(config("embedding", spec));
        expect(result).toMatchObject({ check: "embedding", ok: false });
        expect(result?.message).toContain("768");
    });

    it("check that rerankers rank the relevant document first", async () => {
        mockGateway({});
        expect(await probeModel(config("rerank", { maxInputTokens: 512 }))).toEqual([{ check: "rerank", ok: true }]);
    });
});
