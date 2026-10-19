/** Mirrors apps/server/src/features/ai/model-schema.ts and the /api/ai responses. */

export type AiProviderAdapter = "openai-compatible" | "gemini" | "dashscope-native" | "llama-cpp" | "vllm";
export type AiModelCategory = "generation" | "embedding" | "rerank";
export type AiModality = "text" | "image" | "audio" | "video" | "pdf";
export type AiRoleKey = "describe" | "textEmbedding" | "imageEmbedding" | "rerank";

/** Only these dimensions have a vector index (server: EMBEDDING_DIMENSIONS). */
export const EMBEDDING_DIMENSIONS = [256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072] as const;

export interface AiProviderTemplate {
    id: string;
    name: string;
    adapter: AiProviderAdapter;
    defaultBaseUrl: string;
    description: string;
}

export interface AiProvider {
    id: string;
    template_id: string;
    name: string;
    base_url: string;
    api_key_hint: string | null;
    max_concurrency: number;
    requests_per_minute: number | null;
}

/** Levels of the AI SDK's `reasoning` call option (server: AI_REASONING_LEVELS). */
export const AI_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type AiReasoningLevel = (typeof AI_REASONING_LEVELS)[number];

export interface AiGenerationCapabilities {
    contextWindow: number;
    maxOutputTokens?: number;
    inputModalities: AiModality[];
    imageFormats?: string[];
    structuredOutput: boolean;
    /** Reasoning levels the model accepts, when known from the catalog. */
    reasoningLevels?: AiReasoningLevel[];
    /** Reasoning level requested on every call; absent leaves the provider's default. */
    reasoning?: AiReasoningLevel;
    options?: Record<string, unknown>;
}

export interface AiEmbeddingCapabilities {
    dimension: number;
    mrl: boolean;
    maxInputTokens: number;
    multimodal: boolean;
    imageFormats?: string[];
    taskPrefixType?: "gemini-asymmetric";
    /** Search cut-offs in cosine distance; absent values use the server defaults. */
    matchDistance?: { text?: number; image?: number };
}

export interface AiRerankCapabilities {
    maxInputTokens: number;
}

export type AiModelCapabilities = AiGenerationCapabilities | AiEmbeddingCapabilities | AiRerankCapabilities;

export interface AiModel {
    id: string;
    provider_id: string;
    name: string;
    display_name: string;
    category: AiModelCategory;
    capabilities: AiModelCapabilities;
}

export interface AiCatalogModel {
    name: string;
    displayName: string;
    category: AiModelCategory;
    capabilities: AiModelCapabilities;
    supportedDimensions?: number[];
}

/** Catalog models offered together under a provider or vendor name. */
export interface AiCatalogGroup {
    name: string;
    models: AiCatalogModel[];
}

export interface AiModelProbeResult {
    check: "imageInput" | "structuredOutput" | "embedding" | "imageEmbedding" | "rerank";
    ok: boolean;
    message?: string;
}

export type AiConnectionTestResult = { ok: true; models: string[] } | { ok: false; kind: string; message: string };

export interface AiEmbeddingSpaceStatus {
    role: "textEmbedding" | "imageEmbedding";
    /** RETIRED: the previous ACTIVE space, kept for switching back until `retainedUntil`. */
    status: "ACTIVE" | "BUILDING" | "RETIRED";
    modelId: string;
    spaceId: string;
    ready: number;
    pending: number;
    failed: number;
    /** BUILDING only: why the drained space does not replace the ACTIVE one yet. */
    blocked: "low_coverage" | "too_many_failures" | null;
    retainedUntil: string | null;
    /** Latest error of the vectors still queued or failed. */
    lastError: AiErrorView | null;
}

export interface AiErrorView {
    message: string;
    at: string;
}

export interface AiDescribeStatus {
    completed: number;
    /** Completed descriptions that another model than the current one wrote. */
    otherModel: number;
    pending: number;
    failed: number;
    lastError: AiErrorView | null;
}

/** A bound model the server cannot use; its role is left out until the binding is fixed. */
export interface AiConfigIssue {
    role: AiRoleKey;
    /** The model serves a space that is still being built. */
    building: boolean;
    message: string;
}

export interface AiLibraryStatus {
    mediaTotal: number;
    spaces: AiEmbeddingSpaceStatus[];
    /** Null when no usable description model is bound. */
    describe: AiDescribeStatus | null;
    issues: AiConfigIssue[];
}

export type AiBindings = Partial<Record<AiRoleKey, { modelId: string } | null>> & {
    /** Language image descriptions are written in (BCP 47). */
    language?: string;
};

export function isGenerationCapabilities(capabilities: AiModelCapabilities): capabilities is AiGenerationCapabilities {
    return "contextWindow" in capabilities;
}

export function isEmbeddingCapabilities(capabilities: AiModelCapabilities): capabilities is AiEmbeddingCapabilities {
    return "dimension" in capabilities;
}

export function formatTokenCount(tokens: number | undefined): string {
    if (!tokens) return "—";
    if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`;
    return `${Math.round(tokens / 1000)}K`;
}

/** A one-line summary of what a model definition supports, e.g. "Context 128K · Image · Structured output". */
export function describeModelSpec(capabilities: AiModelCapabilities, t: (key: string, values?: Record<string, unknown>) => string): string {
    if (isEmbeddingCapabilities(capabilities)) {
        return [
            `${capabilities.dimension}d`,
            ...(capabilities.mrl ? ["MRL"] : []),
            capabilities.multimodal ? t("settings.ai_config.spec_multimodal") : t("settings.ai_config.spec_text_only"),
        ].join(" · ");
    }
    if (!isGenerationCapabilities(capabilities)) {
        return t("settings.ai_config.spec_context", { value: formatTokenCount(capabilities.maxInputTokens) });
    }
    return [
        t("settings.ai_config.spec_context", { value: formatTokenCount(capabilities.contextWindow) }),
        ...(capabilities.inputModalities.includes("image") ? [t("settings.ai_config.spec_image")] : []),
        ...(capabilities.structuredOutput ? [t("settings.ai_config.spec_structured")] : []),
        ...(capabilities.reasoning
            ? [t("settings.ai_config.spec_reasoning", { level: t(`settings.ai_config.reasoning_${capabilities.reasoning}`) })]
            : []),
    ].join(" · ");
}

/** AI-generated content of a media item, as returned by the media detail API. */
export interface MediaAiView {
    status: "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
    error: string | null;
    result: {
        caption: string;
        tags: string[];
        objects: string[];
        colors: string[];
        styles: string[];
        scene: string;
        ocr_text: string;
        model: string;
        generated_time: string | null;
    } | null;
}
