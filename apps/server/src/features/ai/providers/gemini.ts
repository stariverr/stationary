import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { EmbeddingModelCapabilities, GeneratedTextModelCapabilities } from "../model-schema";
import type {
    DescribeImageRequestOptions,
    EmbedImageParams,
    EmbeddingResult,
    LanguageProvider,
    ResolvedModelConfig,
    VisualEmbeddingProvider,
} from "../types";
import { AiProviderError } from "../errors";
import { toEmbeddingResult } from "../utils";
import { guardedFetch } from "./egress";
import { postJson } from "./http";
import { SdkTextEmbeddingProvider } from "./sdk-embedding";

export function geminiApiBaseUrl(baseUrl: string): string {
    const normalized = (baseUrl || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
    return normalized.endsWith("/v1beta") ? normalized : `${normalized}/v1beta`;
}

/**
 * Google Gemini speaks its own wire protocol: the AI SDK covers chat + text embeddings,
 * while image embeddings use the native embedContent REST endpoint.
 */
export class GeminiLanguageProvider implements LanguageProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly chatModel: LanguageModel;
    readonly capabilities: GeneratedTextModelCapabilities;
    readonly describeOptions: DescribeImageRequestOptions;

    constructor(config: ResolvedModelConfig) {
        const spec = config.capabilities as GeneratedTextModelCapabilities;

        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = spec;
        this.describeOptions = {
            maxOutputTokens: spec.maxOutputTokens,
            reasoning: spec.reasoning,
            providerOptions: spec.options ? { google: spec.options } : undefined,
            // Gemini rejects additionalProperties in its response schema.
            strictJsonSchema: false,
        };

        const google = createGoogleGenerativeAI({
            apiKey: config.apiKey || "",
            baseURL: geminiApiBaseUrl(config.baseUrl),
            fetch: guardedFetch as typeof fetch,
        });
        this.chatModel = google.chat(this.modelName);
    }
}

function embeddingOptions(spec: EmbeddingModelCapabilities) {
    return spec.mrl ? { google: { outputDimensionality: spec.dimension } } : undefined;
}

function createEmbeddingModel(config: ResolvedModelConfig) {
    return createGoogleGenerativeAI({
        apiKey: config.apiKey || "",
        baseURL: geminiApiBaseUrl(config.baseUrl),
        fetch: guardedFetch as typeof fetch,
    }).embeddingModel(config.modelName);
}

export class GeminiTextEmbeddingProvider extends SdkTextEmbeddingProvider {
    constructor(config: ResolvedModelConfig) {
        super(config, createEmbeddingModel(config), embeddingOptions(config.capabilities as EmbeddingModelCapabilities));
    }
}

/** Gemini image embeddings use the native batchEmbedContents endpoint, one request per batch. */
export class GeminiVisualEmbeddingProvider extends GeminiTextEmbeddingProvider implements VisualEmbeddingProvider {
    /** Keeps inline image payloads well below the request size limit. */
    readonly imageBatchSize = 6;
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(config: ResolvedModelConfig) {
        super(config);
        this.apiKey = config.apiKey || "";
        this.baseUrl = geminiApiBaseUrl(config.baseUrl);
    }

    async embedImages(params: EmbedImageParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        const model = `models/${this.modelName}`;
        const resJson = await postJson<{ embeddings?: Array<{ values?: number[] }> }>(`${this.baseUrl}/${model}:batchEmbedContents`, {
            headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
            json: {
                requests: params.map((image) => ({
                    model,
                    content: {
                        parts: [{ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.imageBuffer).toString("base64") } }],
                    },
                    ...(this.capabilities.mrl ? { outputDimensionality: this.capabilities.dimension } : {}),
                })),
            },
            signal: abortSignal,
        });
        const embeddings = resJson?.embeddings ?? [];
        if (embeddings.length !== params.length) {
            throw new AiProviderError(
                "TRANSIENT",
                `Model '${this.modelName}' returned ${embeddings.length} embeddings for ${params.length} images.`,
            );
        }
        return embeddings.map((embedding) => toEmbeddingResult(embedding.values, this.modelName, this.capabilities));
    }
}
