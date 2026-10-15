import { describe, expect, it } from "bun:test";
import { parseModelCapabilities, supportsAiBindingRole } from "@/features/ai/model-schema";

const generationModel = {
    contextWindow: 8192,
    maxOutputTokens: 1024,
    inputModalities: ["text", "image"],
    imageFormats: ["image/jpeg"],
    structuredOutput: true,
};

const textEmbeddingModel = {
    dimension: 768,
    maxInputTokens: 8192,
    multimodal: false,
};

const visualEmbeddingModel = {
    ...textEmbeddingModel,
    multimodal: true,
    imageFormats: ["image/jpeg", "image/heic"],
};

describe("AI model capability validation", () => {
    it("accepts valid model specs and rejects incomplete specs", () => {
        expect(parseModelCapabilities("generation", generationModel)).not.toBeNull();
        expect(parseModelCapabilities("embedding", textEmbeddingModel)).not.toBeNull();
        expect(parseModelCapabilities("embedding", { ...textEmbeddingModel, dimension: 0 })).toBeNull();
    });

    it("only accepts reasoning levels the model supports", () => {
        expect(parseModelCapabilities("generation", { ...generationModel, reasoning: "low" })).not.toBeNull();
        expect(parseModelCapabilities("generation", { ...generationModel, reasoningLevels: ["low", "high"], reasoning: "low" })).not.toBeNull();
        expect(parseModelCapabilities("generation", { ...generationModel, reasoningLevels: ["high"], reasoning: "low" })).toBeNull();
        expect(parseModelCapabilities("generation", { ...generationModel, reasoning: "max" })).toBeNull();
    });

    it("requires explicit image formats whenever a model accepts images", () => {
        expect(
            parseModelCapabilities("generation", {
                ...generationModel,
                imageFormats: undefined,
            }),
        ).toBeNull();
        expect(parseModelCapabilities("embedding", { ...visualEmbeddingModel, imageFormats: [] })).toBeNull();
        expect(parseModelCapabilities("embedding", visualEmbeddingModel)).not.toBeNull();
    });

    it("accepts custom image MIME types and normalizes them", () => {
        const spec = parseModelCapabilities("generation", { ...generationModel, imageFormats: ["IMAGE/HEIC"] });
        expect(spec && "imageFormats" in spec ? spec.imageFormats : null).toEqual(["image/heic"]);
    });

    it("only enables roles supported by the model capabilities", () => {
        const generation = parseModelCapabilities("generation", generationModel);
        const textEmbedding = parseModelCapabilities("embedding", textEmbeddingModel);
        const visualEmbedding = parseModelCapabilities("embedding", visualEmbeddingModel);

        expect(generation && supportsAiBindingRole("describe", generation)).toBe(true);
        expect(textEmbedding && supportsAiBindingRole("imageEmbedding", textEmbedding)).toBe(false);
        expect(visualEmbedding && supportsAiBindingRole("imageEmbedding", visualEmbedding)).toBe(true);
    });
});
