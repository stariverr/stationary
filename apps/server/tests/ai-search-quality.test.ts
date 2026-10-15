import { afterEach, describe, expect, it } from "bun:test";
import { isSupportedLanguage, languageName, normalizeImageAiMetadata } from "@/features/ai/image-metadata";
import { parseModelCapabilities, supportsAiBindingRole } from "@/features/ai/model-schema";
import { adapterSupportsModel } from "@/features/ai/provider-templates";
import { buildSearchContent, selectStoredMetadata } from "@/features/ai/enrich";
import { escapeLikePattern, HybridSearchService } from "@/features/ai/search";
import { CohereRerankProvider } from "@/features/ai/providers/cohere-rerank";
import type { ResolvedModelConfig } from "@/features/ai/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

const rerankConfig: ResolvedModelConfig = {
    providerId: "p",
    limits: { maxConcurrency: 4, requestsPerMinute: null },
    providerName: "vLLM",
    adapter: "openai-compatible",
    baseUrl: "http://rerank.test/v1/",
    apiKey: "",
    modelName: "Qwen/Qwen3-Reranker-0.6B",
    category: "rerank",
    capabilities: { maxInputTokens: 30 },
};

describe("rerank models", () => {
    it("are a model category served only by OpenAI-compatible connections", () => {
        const capabilities = parseModelCapabilities("rerank", { maxInputTokens: 8192 });
        expect(capabilities).toEqual({ maxInputTokens: 8192 });
        expect(supportsAiBindingRole("rerank", capabilities!)).toBe(true);
        expect(supportsAiBindingRole("textEmbedding", capabilities!)).toBe(false);
        expect(adapterSupportsModel("openai-compatible", "rerank", capabilities!)).toBe(true);
        expect(adapterSupportsModel("gemini", "rerank", capabilities!)).toBe(false);
        expect(parseModelCapabilities("rerank", {})).toBeNull();
    });

    it("call the Cohere-style /rerank endpoint and return scores in input order", async () => {
        let body: any;
        globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
            const request = input instanceof Request ? input : new Request(String(input), init);
            expect(request.url).toBe("http://rerank.test/v1/rerank");
            body = await request.json();
            return new Response(
                JSON.stringify({
                    results: [
                        { index: 1, relevance_score: 0.9 },
                        { index: 0, relevance_score: 0.2 },
                    ],
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            );
        }) as unknown as typeof fetch;

        const scores = await new CohereRerankProvider(rerankConfig).rerank("cat", ["a car", "a cat", "x".repeat(500)]);

        expect(body.query).toBe("cat");
        expect(body.top_n).toBe(3);
        // Documents are cut to the pair budget (90% of maxInputTokens).
        expect(body.documents[2].length).toBeLessThan(500);
        expect(scores).toEqual([0.2, 0.9, Number.NEGATIVE_INFINITY]);
    });
});

describe("embedding search cut-offs", () => {
    it("are optional, per model, and bounded to cosine distance", () => {
        const base = { dimension: 768, maxInputTokens: 8192, multimodal: true, imageFormats: ["image/avif"] };
        expect(parseModelCapabilities("embedding", { ...base, matchDistance: { text: 0.35, image: 0.7 } })).toMatchObject({
            matchDistance: { text: 0.35, image: 0.7 },
        });
        expect(parseModelCapabilities("embedding", { ...base, matchDistance: { text: 2.5 } })).toBeNull();
    });
});

describe("description language", () => {
    it("accepts the app's locales and names them for the prompt", () => {
        expect(isSupportedLanguage("zh-Hans")).toBe(true);
        expect(isSupportedLanguage("en-US")).toBe(true);
        expect(isSupportedLanguage("not a language")).toBe(false);
        expect(languageName("zh-Hans")).toContain("Chinese");
    });
});

describe("description output bounds", () => {
    it("cuts runaway fields instead of failing the description", () => {
        const metadata = normalizeImageAiMetadata({
            caption: "x".repeat(5000),
            tags: [...Array.from({ length: 100 }, (_, index) => `tag ${index}`), "tag 0", " "],
            objects: ["cat", " cat ", "y".repeat(500)],
            colors: [],
            styles: [],
            scene: "street",
            ocrText: "z".repeat(10_000),
        });
        expect(metadata.caption).toHaveLength(1000);
        expect(metadata.tags).toHaveLength(30);
        expect(metadata.objects).toEqual(["cat", "y".repeat(80)]);
        expect(metadata.scene).toBe("street");
        expect(metadata.ocrText).toHaveLength(4000);
    });
});

describe("keyword search input", () => {
    it("matches LIKE wildcards literally", () => {
        expect(escapeLikePattern("100%_off\\")).toBe("100\\%\\_off\\\\");
        expect(escapeLikePattern("cat")).toBe("cat");
    });

    it("stores plain field values, so field names never match every document", () => {
        const content = buildSearchContent(["Sunset", "", "Sunset", null, "beach, sea", "  ", "海边日落"]);
        expect(content).toBe("Sunset\nbeach, sea\n海边日落");
        expect(content.toLowerCase()).not.toContain("title");
    });
});

describe("reciprocal rank fusion", () => {
    it("ranks from 1 and sums weighted channel scores", () => {
        const fused = HybridSearchService.reciprocalRankFusion(
            [
                [
                    { id: "a", title: "A" },
                    { id: "b", title: "B" },
                ],
                [{ id: "b", title: "B", distance: 0.2 }],
            ],
            { k: 60, weights: [1, 1] },
        );
        expect(fused.map((item) => item.mediaId)).toEqual(["b", "a"]);
        expect(fused[1]!.score).toBeCloseTo(1 / 61);
        expect(fused[0]!.score).toBeCloseTo(1 / 62 + 1 / 61);
    });
});

describe("stored description selection", () => {
    const at = (iso: string) => Temporal.Instant.from(iso);
    const rows = [
        {
            metadata_pipeline_id: "m:v2:en-US",
            input_hash: "h",
            create_time: at("2026-01-01T00:00:00Z"),
            update_time: at("2026-03-01T00:00:00Z"),
        },
        { metadata_pipeline_id: "m:v2:zh-Hans", input_hash: "h", create_time: at("2026-02-01T00:00:00Z"), update_time: null },
        { metadata_pipeline_id: "m:v3:zh-Hans", input_hash: null, create_time: at("2026-04-01T00:00:00Z"), update_time: null },
    ];

    it("prefers the current pipeline's result", () => {
        expect(selectStoredMetadata(rows, "m:v2:zh-Hans")?.metadata_pipeline_id).toBe("m:v2:zh-Hans");
    });

    it("falls back to the newest result while the current pipeline has none", () => {
        expect(selectStoredMetadata(rows, "m:v3:zh-Hans")?.metadata_pipeline_id).toBe("m:v2:en-US");
        expect(selectStoredMetadata(rows, null)?.metadata_pipeline_id).toBe("m:v2:en-US");
        expect(selectStoredMetadata([rows[2]!], "m:v3:zh-Hans")).toBeNull();
    });
});

describe("image embeddings over the OpenAI protocol", () => {
    it("are not offered, since the embeddings API has no image input", () => {
        const multimodal = parseModelCapabilities("embedding", {
            dimension: 1024,
            maxInputTokens: 8192,
            multimodal: true,
            imageFormats: ["image/jpeg"],
        })!;
        const textOnly = parseModelCapabilities("embedding", { dimension: 1024, maxInputTokens: 8192, multimodal: false })!;
        expect(adapterSupportsModel("openai-compatible", "embedding", multimodal)).toBe(false);
        expect(adapterSupportsModel("openai-compatible", "embedding", textOnly)).toBe(true);
        expect(adapterSupportsModel("gemini", "embedding", multimodal)).toBe(true);
    });
});
