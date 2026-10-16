import { AiConfigurationError } from "../errors";
import type { LanguageProvider, RerankProvider, ResolvedModelConfig, TextEmbeddingProvider, VisualEmbeddingProvider } from "../types";
import { CohereRerankProvider } from "./cohere-rerank";
import { DashScopeMultimodalEmbeddingProvider } from "./dashscope";
import { GeminiLanguageProvider, GeminiTextEmbeddingProvider, GeminiVisualEmbeddingProvider } from "./gemini";
import {
    OpenAiCompatibleLanguageProvider,
    OpenAiCompatibleTextEmbeddingProvider,
} from "./openai-compatible";
import { LlamaCppEmbeddingProvider, VllmEmbeddingProvider } from "./self-hosted-embedding";

export {
    DashScopeMultimodalEmbeddingProvider,
    GeminiLanguageProvider,
    GeminiTextEmbeddingProvider,
    GeminiVisualEmbeddingProvider,
    LlamaCppEmbeddingProvider,
    OpenAiCompatibleLanguageProvider,
    OpenAiCompatibleTextEmbeddingProvider,
    VllmEmbeddingProvider,
};

/**
 * Adapter selection is the only place that knows which wire protocol a model
 * uses. Resolver and callers never need vendor-specific branching.
 */
export function buildLanguageProvider(config: ResolvedModelConfig): LanguageProvider {
    switch (config.adapter) {
        case "openai-compatible":
            return new OpenAiCompatibleLanguageProvider(config);
        case "gemini":
            return new GeminiLanguageProvider(config);
        case "dashscope-native":
        case "llama-cpp":
        case "vllm":
            throw new AiConfigurationError(`The ${config.adapter} adapter does not support text generation.`);
        default:
            throw new AiConfigurationError(`Unsupported provider adapter '${String(config.adapter)}'.`);
    }
}

export function buildRerankProvider(config: ResolvedModelConfig): RerankProvider {
    if (config.adapter === "openai-compatible") return new CohereRerankProvider(config);
    throw new AiConfigurationError(`The ${config.adapter} adapter does not support rerank models.`);
}

export function buildTextEmbeddingProvider(config: ResolvedModelConfig): TextEmbeddingProvider {
    switch (config.adapter) {
        case "openai-compatible":
            return new OpenAiCompatibleTextEmbeddingProvider(config);
        case "gemini":
            return new GeminiTextEmbeddingProvider(config);
        case "dashscope-native":
            return new DashScopeMultimodalEmbeddingProvider(config);
        case "llama-cpp":
            return new LlamaCppEmbeddingProvider(config);
        case "vllm":
            return new VllmEmbeddingProvider(config);
        default:
            throw new AiConfigurationError(`Unsupported provider adapter '${String(config.adapter)}'.`);
    }
}

export function buildVisualEmbeddingProvider(config: ResolvedModelConfig): VisualEmbeddingProvider {
    switch (config.adapter) {
        case "openai-compatible":
            throw new AiConfigurationError("The OpenAI embeddings protocol has no image input.");
        case "gemini":
            return new GeminiVisualEmbeddingProvider(config);
        case "dashscope-native":
            return new DashScopeMultimodalEmbeddingProvider(config);
        case "llama-cpp":
            return new LlamaCppEmbeddingProvider(config);
        case "vllm":
            return new VllmEmbeddingProvider(config);
        default:
            throw new AiConfigurationError(`Unsupported provider adapter '${String(config.adapter)}'.`);
    }
}
