import * as v from "valibot";

/** The wire protocol implemented by a provider adapter. Vendor names are not adapters. */
export const AiProviderAdapterSchema = v.picklist(["openai-compatible", "gemini", "dashscope-native", "llama-cpp", "vllm"]);
export type AiProviderAdapter = v.InferOutput<typeof AiProviderAdapterSchema>;

export const AI_MODEL_CATEGORIES = ["generation", "embedding", "rerank"] as const;
export const AiModelCategorySchema = v.picklist(AI_MODEL_CATEGORIES);
export type AiModelCategory = v.InferOutput<typeof AiModelCategorySchema>;

export const AiModalitySchema = v.picklist(["text", "image", "audio", "video", "pdf"]);
export type AiModality = v.InferOutput<typeof AiModalitySchema>;

/**
 * Image formats are MIME types, not a closed enum. Providers occasionally accept
 * proprietary formats, so the model definition must be able to describe them.
 */
export const ImageFormatSchema = v.pipe(
    v.string(),
    v.regex(/^image\/[a-z0-9][a-z0-9.+-]*$/i, "Image format must be an image MIME type"),
    v.transform((value) => value.toLowerCase()),
);
export type ImageFormat = v.InferOutput<typeof ImageFormatSchema>;

const ImageFormatsSchema = v.pipe(v.array(ImageFormatSchema), v.minLength(1));

/** Levels of the AI SDK's provider-neutral `reasoning` call option; adapters map them to the wire. */
export const AI_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export const ReasoningLevelSchema = v.picklist(AI_REASONING_LEVELS);
export type ReasoningLevel = v.InferOutput<typeof ReasoningLevelSchema>;

export const GeneratedTextModelCapabilitiesSchema = v.pipe(
    v.object({
        contextWindow: v.pipe(v.number(), v.integer(), v.minValue(1)),
        maxOutputTokens: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
        inputModalities: v.pipe(v.array(AiModalitySchema), v.minLength(1)),
        imageFormats: v.optional(ImageFormatsSchema),
        structuredOutput: v.boolean(),
        /** Reasoning levels the model accepts, when known from the catalog. */
        reasoningLevels: v.optional(v.pipe(v.array(ReasoningLevelSchema), v.minLength(1))),
        /** Reasoning level requested on every call; absent leaves the provider's default. */
        reasoning: v.optional(ReasoningLevelSchema),
        options: v.optional(v.record(v.string(), v.unknown())),
    }),
    v.check(
        (spec) => !spec.inputModalities.includes("image") || Boolean(spec.imageFormats?.length),
        "imageFormats is required when a model accepts image input",
    ),
    v.check((spec) => spec.inputModalities.includes("text"), "Generation models must accept text input"),
    v.check(
        (spec) => !spec.reasoning || !spec.reasoningLevels || spec.reasoningLevels.includes(spec.reasoning),
        "The reasoning level must be one the model accepts",
    ),
);
export type GeneratedTextModelCapabilities = v.InferOutput<typeof GeneratedTextModelCapabilitiesSchema>;

/**
 * Output dimensions that have a partial HNSW index on `asset_embedding`. pgvector indexes
 * halfvec up to 4000 dimensions, so larger native outputs must be shortened through MRL.
 */
export const EMBEDDING_DIMENSIONS = [256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072] as const;
export type EmbeddingDimension = (typeof EMBEDDING_DIMENSIONS)[number];

export const EmbeddingModelCapabilitiesSchema = v.pipe(
    v.object({
        dimension: v.picklist(EMBEDDING_DIMENSIONS, `Embedding dimension must be one of ${EMBEDDING_DIMENSIONS.join(", ")}`),
        /** Whether the provider accepts a requested output dimension (Matryoshka truncation). */
        mrl: v.optional(v.boolean(), false),
        maxInputTokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
        multimodal: v.boolean(),
        imageFormats: v.optional(ImageFormatsSchema),
        taskPrefixType: v.optional(v.picklist(["gemini-asymmetric"])),
        /**
         * Search cut-offs in cosine distance (0–2): matches farther than these are dropped. Model
         * specific and search-time only, so changing them never requires re-embedding.
         */
        matchDistance: v.optional(
            v.object({
                text: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
                image: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(2))),
            }),
        ),
    }),
    v.check((spec) => !spec.multimodal || Boolean(spec.imageFormats?.length), "imageFormats is required for a multimodal embedding model"),
);
export type EmbeddingModelCapabilities = v.InferOutput<typeof EmbeddingModelCapabilitiesSchema>;

/** Cross-encoder rerankers: score (query, document) pairs to reorder search candidates. */
export const RerankModelCapabilitiesSchema = v.object({
    /** Tokens of one query + document pair the model reads; longer documents are cut. */
    maxInputTokens: v.pipe(v.number(), v.integer(), v.minValue(1)),
});
export type RerankModelCapabilities = v.InferOutput<typeof RerankModelCapabilitiesSchema>;

export type AiModelCapabilities = GeneratedTextModelCapabilities | EmbeddingModelCapabilities | RerankModelCapabilities;

export function parseModelCapabilities(category: AiModelCategory, input: unknown): AiModelCapabilities | null {
    const schema =
        category === "generation"
            ? GeneratedTextModelCapabilitiesSchema
            : category === "embedding"
              ? EmbeddingModelCapabilitiesSchema
              : RerankModelCapabilitiesSchema;
    const result = v.safeParse(schema, input);
    return result.success ? result.output : null;
}

export const AI_BINDING_ROLES = ["describe", "textEmbedding", "imageEmbedding", "rerank"] as const;
export type AiBindingRole = (typeof AI_BINDING_ROLES)[number];

export function supportsAiBindingRole(role: AiBindingRole, capabilities: AiModelCapabilities): boolean {
    if (role === "describe") {
        return "inputModalities" in capabilities && capabilities.inputModalities.includes("image") && capabilities.structuredOutput;
    }
    if (role === "imageEmbedding") {
        return "multimodal" in capabilities && capabilities.multimodal;
    }
    if (role === "rerank") {
        return !("dimension" in capabilities) && !("inputModalities" in capabilities);
    }
    return "dimension" in capabilities;
}

export const RoleBindingSchema = v.object({
    modelId: v.pipe(v.string(), v.uuid("Invalid model ID")),
});
export type RoleBinding = v.InferOutput<typeof RoleBindingSchema>;

export const LibraryAiBindingsSchema = v.object({
    describe: v.optional(v.nullable(RoleBindingSchema)),
    textEmbedding: v.optional(v.nullable(RoleBindingSchema)),
    imageEmbedding: v.optional(v.nullable(RoleBindingSchema)),
    rerank: v.optional(v.nullable(RoleBindingSchema)),
});
export type LibraryAiBindings = v.InferOutput<typeof LibraryAiBindingsSchema>;
