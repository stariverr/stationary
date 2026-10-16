import { describe, expect, it } from "bun:test";
import { CATALOG_DATA, createModelCatalog, getProviderCatalog, matchCatalogModels } from "@/features/ai/catalog";
import { CURATED_EMBEDDING_MODELS, MIN_RELEASE_DATE } from "@/features/ai/catalog/curated";
import { dropSupersededModels, isRetiredModel, parseModelLine } from "@/features/ai/catalog/lifecycle";
import { buildCatalog, catalogProviderIds, toGenerationCatalogModel } from "@/features/ai/catalog/models-dev";
import { normalizeModelId, type CatalogModel } from "@/features/ai/catalog/types";
import { EMBEDDING_DIMENSIONS, parseModelCapabilities } from "@/features/ai/model-schema";
import { adapterSupportsModel, getProviderTemplate } from "@/features/ai/provider-templates";

const visionModel = {
    id: "vision-1",
    name: "Vision 1",
    structured_output: true,
    modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    limit: { context: 128000, output: 16384 },
};

describe("models.dev mapping", () => {
    it("maps vision models to describe-capable generation definitions", () => {
        expect(toGenerationCatalogModel(visionModel)).toMatchObject({
            name: "vision-1",
            category: "generation",
            capabilities: {
                contextWindow: 128000,
                maxOutputTokens: 16384,
                inputModalities: ["text", "image", "pdf"],
                imageFormats: ["image/jpeg", "image/png", "image/webp"],
                structuredOutput: true,
            },
        });
    });

    it("keeps text-only models so lookups can tell they cannot see images", () => {
        const model = toGenerationCatalogModel({ ...visionModel, modalities: { input: ["text"], output: ["text"] } });
        expect(model?.capabilities).toMatchObject({ inputModalities: ["text"] });
        expect(model?.capabilities).not.toHaveProperty("imageFormats");
    });

    it("skips deprecated, incomplete, embedding and image or audio generating models", () => {
        expect(toGenerationCatalogModel({ ...visionModel, status: "deprecated" })).toBeNull();
        expect(toGenerationCatalogModel({ ...visionModel, limit: {} })).toBeNull();
        expect(toGenerationCatalogModel({ ...visionModel, id: "text-embedding-3-small" })).toBeNull();
        expect(toGenerationCatalogModel({ ...visionModel, modalities: { input: ["text"], output: ["image"] } })).toBeNull();
        expect(toGenerationCatalogModel({ ...visionModel, modalities: { input: ["text", "image"], output: ["text", "audio"] } })).toBeNull();
    });

    it("maps effort levels the AI SDK can request and defaults to low reasoning", () => {
        const effort = (values: string[]) => toGenerationCatalogModel({ ...visionModel, reasoning_options: [{ type: "effort", values }] });
        expect(effort(["none", "low", "medium", "high", "max"])?.capabilities).toMatchObject({
            reasoningLevels: ["none", "low", "medium", "high"],
            reasoning: "low",
        });
        expect(effort(["minimal", "high"])?.capabilities).toMatchObject({ reasoningLevels: ["minimal", "high"], reasoning: "minimal" });
        expect(effort(["high"])?.capabilities).toMatchObject({ reasoningLevels: ["high"] });
        expect(effort(["high"])?.capabilities).not.toHaveProperty("reasoning");
        const budgetOnly = toGenerationCatalogModel({ ...visionModel, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens" }] });
        expect(budgetOnly?.capabilities).not.toHaveProperty("reasoningLevels");
    });

    it("uses the vendor's documented image formats", () => {
        expect(toGenerationCatalogModel({ ...visionModel, id: "claude-x" })?.capabilities).toMatchObject({
            imageFormats: ["image/jpeg", "image/png", "image/gif", "image/webp"],
        });
    });

    it("treats unknown structured output support as unsupported and applies patches", () => {
        expect(toGenerationCatalogModel({ ...visionModel, structured_output: null })?.capabilities).toMatchObject({
            structuredOutput: false,
        });
        expect(toGenerationCatalogModel(visionModel, { structuredOutput: false })?.capabilities).toMatchObject({ structuredOutput: false });
    });
});

describe("model lifecycle", () => {
    const model = (name: string, releaseDate: string | null = "2026-01-01"): CatalogModel => ({
        name,
        displayName: name,
        category: "generation",
        capabilities: { contextWindow: 8000, inputModalities: ["text"], structuredOutput: false },
        releaseDate,
    });
    const names = (models: CatalogModel[]) => models.map((item) => item.name).sort();

    it("reads product lines and versions from ids", () => {
        expect(parseModelLine("gemini-3.8-flash")).toEqual({ line: "gemini-*-flash", version: [3, 8], preview: false });
        expect(parseModelLine("gemini-3-flash-preview")).toEqual({ line: "gemini-*-flash", version: [3], preview: true });
        expect(parseModelLine("claude-sonnet-4-5-20250929")).toEqual({ line: "claude-sonnet-*", version: [4, 5], preview: false });
        expect(parseModelLine("gpt-4o-2024-11-20")?.line).toBe("gpt-*o");
        expect(parseModelLine("gemma-4-31b-it")).toEqual({ line: "gemma-*-31b-it", version: [4], preview: false });
        expect(parseModelLine("MiniMax/MiniMax-M2.7")?.line).toBe("minimax-m*");
        expect(parseModelLine("gemini-flash-latest")).toBeNull();
    });

    it("keeps the newest version of each line, preferring stable releases", () => {
        const models = [
            "gemini-3.5-flash",
            "gemini-3.8-flash",
            "gemini-3-flash-preview",
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash-lite-preview",
            "gemini-3-pro-image-preview",
            "gemini-3-pro-image",
            "claude-sonnet-4-5",
            "claude-sonnet-4-5-20250929",
            "gemini-flash-latest",
        ].map((name) => model(name));
        expect(names(dropSupersededModels(models))).toEqual([
            "claude-sonnet-4-5",
            "claude-sonnet-4-5-20250929",
            "gemini-3-pro-image",
            "gemini-3.5-flash-lite-preview",
            "gemini-3.8-flash",
            "gemini-flash-latest",
        ]);
    });

    it("retires models older than the floor or listed as end of life", () => {
        expect(isRetiredModel(model("gpt-x", "2024-05-13"))).toBe(true);
        expect(isRetiredModel(model("gpt-x", MIN_RELEASE_DATE))).toBe(false);
        expect(isRetiredModel(model("gpt-x", null))).toBe(false);
        expect(isRetiredModel(model("o3-pro"))).toBe(true);
        expect(isRetiredModel(model("openai/O4-mini"))).toBe(true);
    });
});

describe("catalog generation", () => {
    const emptyModelsDev = () => Object.fromEntries(catalogProviderIds().map((id) => [id, { models: {} }]));

    it("fails loudly when models.dev drops a referenced provider", () => {
        const body = emptyModelsDev();
        delete body.google;
        expect(() => buildCatalog(body)).toThrow("google");
    });

    it("leaves out superseded and retired models", () => {
        const body = emptyModelsDev();
        body.google = {
            models: {
                "gemini-3.5-flash": { ...visionModel, id: "gemini-3.5-flash", release_date: "2026-05-19" },
                "gemini-3.8-flash": { ...visionModel, id: "gemini-3.8-flash", release_date: "2026-09-02" },
                "gemini-1.5-pro": { ...visionModel, id: "gemini-1.5-pro", release_date: "2024-02-15" },
            },
        };
        expect(buildCatalog(body).providers.google!.map((model) => model.name)).toEqual(["gemini-3.8-flash", "gemini-embedding-2"]);
    });

    it("replaces models.dev entries with curated embedding definitions", () => {
        const body = emptyModelsDev();
        body["alibaba-cn"] = { models: { "qwen3-vl-embedding": { ...visionModel, id: "qwen3-vl-embedding" }, "vision-1": visionModel } };
        const alibaba = buildCatalog(body).providers["alibaba-cn"]!;
        expect(alibaba.map((model) => model.name)).toEqual(["qwen3-vl-embedding", "vision-1"]);
        expect(alibaba.find((model) => model.name === "qwen3-vl-embedding")?.category).toBe("embedding");
    });
});

describe("generated catalog", () => {
    it("only contains valid definitions", () => {
        for (const models of Object.values(CATALOG_DATA.providers)) {
            for (const model of models) expect(parseModelCapabilities(model.category, model.capabilities)).not.toBeNull();
        }
    });

    it("covers every catalog provider and is up to date with the curated data", () => {
        expect(Object.keys(CATALOG_DATA.providers).sort()).toEqual(catalogProviderIds());
        for (const curated of CURATED_EMBEDDING_MODELS) {
            const model = CATALOG_DATA.providers[curated.catalogProviderId]?.find((item) => item.name === curated.name);
            expect(model?.capabilities).toEqual(curated.capabilities);
        }
    });

    it("lists indexable embedding dimensions only", () => {
        for (const curated of CURATED_EMBEDDING_MODELS) {
            expect(curated.supportedDimensions).toContain(curated.capabilities.dimension);
            for (const dimension of curated.supportedDimensions) expect(EMBEDDING_DIMENSIONS).toContain(dimension);
        }
    });
});

describe("catalog lookup", () => {
    const generation = (name: string, contextWindow: number, image = true): CatalogModel => ({
        name,
        displayName: name,
        category: "generation",
        capabilities: {
            contextWindow,
            inputModalities: image ? ["text", "image"] : ["text"],
            ...(image ? { imageFormats: ["image/png"] } : {}),
            structuredOutput: true,
        },
    });
    const catalog = createModelCatalog({
        providers: {
            deepseek: [generation("deepseek-flash", 1000)],
            "alibaba-cn": [generation("deepseek-flash", 2000, false), generation("qwen-vl", 3000), ...CATALOG_DATA.providers["alibaba-cn"]!],
            google: [generation("gemini-3-flash", 4000)],
            "open-weights": CATALOG_DATA.providers["open-weights"]!,
        },
    });
    const custom = getProviderTemplate("custom-openai-compatible")!;
    const dashscope = getProviderTemplate("dashscope-compatible")!;
    const match = (template: typeof custom, id: string) => catalog.matchCatalogModels(template, [id])[0] ?? null;

    it("prefers the provider's own listing, even when it cannot see images", () => {
        expect(match(dashscope, "deepseek-flash")?.capabilities).toMatchObject({ contextWindow: 2000, inputModalities: ["text"] });
    });

    it("resolves other ids through a gateway namespace, then the model's vendor", () => {
        expect(match(custom, "alibaba-cn/deepseek-flash")?.capabilities).toMatchObject({ contextWindow: 2000 });
        expect(match(custom, "aliyun/deepseek-flash")?.capabilities).toMatchObject({ contextWindow: 1000 });
        expect(match(custom, "Google/Gemini-3-Flash")).toMatchObject({ name: "Google/Gemini-3-Flash", capabilities: { contextWindow: 4000 } });
        expect(match(custom, "unknown-model")).toBeNull();
    });

    it("only offers what the provider's adapter can serve", () => {
        const native = getProviderTemplate("dashscope-native")!;
        const offered = (template: typeof custom) => catalog.getProviderCatalog(template).flatMap((group) => group.models.map((model) => model.name));
        expect(offered(native)).toEqual(["qwen3-vl-embedding"]);
        expect(offered(getProviderTemplate("llama-cpp")!)).toEqual(["embeddinggemma-2", "qwen3-vl-embedding"]);
        expect(match(getProviderTemplate("vllm")!, "google/EmbeddingGemma-2")?.capabilities).toMatchObject({ dimension: 768, mrl: true });
        expect(offered(dashscope)).not.toContain("deepseek-flash");
        expect(match(custom, "qwen3-vl-embedding")).toBeNull();
    });

    it("offers gateways every vendor's own models, grouped by vendor", () => {
        const groups = getProviderCatalog(custom);
        expect(groups.map((group) => group.name)).toContain("Google");
        const google = groups.find((group) => group.name === "Google")!;
        expect(google.models.every((model) => model.name.startsWith("gemini-") || model.name.startsWith("gemma-"))).toBe(true);
        expect(groups.flatMap((group) => group.models).some((model) => model.name === "gemini-embedding-2")).toBe(false);
    });

    it("serves the generated catalog to every template", () => {
        const openai = getProviderTemplate("openai")!;
        const groups = getProviderCatalog(openai);
        expect(groups.map((group) => group.name)).toEqual(["OpenAI"]);
        for (const model of groups[0]!.models) {
            expect(adapterSupportsModel(openai.adapter, model.category, model.capabilities)).toBe(true);
            expect(normalizeModelId(model.name)).toBe(model.name.toLowerCase());
        }
    });
});
