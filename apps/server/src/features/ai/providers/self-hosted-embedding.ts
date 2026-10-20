import type { EmbeddingModelCapabilities } from "../model-schema";
import type { EmbedImageParams, EmbedTextParams, EmbeddingResult, ResolvedModelConfig, VisualEmbeddingProvider } from "../types";
import { AiProviderError } from "../errors";
import { computeEmbeddingSpaceId, formatEmbeddingText, imageBase64, shortenMrlVector, toEmbeddingResult } from "../utils";
import { postJson } from "./http";

interface EmbeddingsResponse {
    data?: Array<{ index?: number; embedding: unknown }>;
}

/** The `image_url.url` of an image: its own URL, which the server downloads, or its bytes as a data URI. */
function imageUrl(image: EmbedImageParams): string {
    return "url" in image ? image.url : `data:${image.mimeType};base64,${imageBase64(image)}`;
}

/**
 * Multimodal embeddings from self-hosted inference servers (llama.cpp, vLLM). They share the
 * OpenAI `/embeddings` endpoint and response, and take text as plain strings; they differ in how
 * an image is put into the request, which each subclass defines. Text and images go through the
 * same model, so they land in the same vector space.
 */
export abstract class SelfHostedEmbeddingProvider implements VisualEmbeddingProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: EmbeddingModelCapabilities;
    readonly spaceId: string;
    readonly textBatchSize = 32;
    readonly fetchesImageUrls = true;
    abstract readonly imageBatchSize: number;
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(config: ResolvedModelConfig) {
        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = config.capabilities as EmbeddingModelCapabilities;
        this.spaceId = computeEmbeddingSpaceId(this.modelName, this.capabilities);
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    }

    /** The request fields that carry `images`, one embedding per image, in order. */
    protected abstract imageRequestFields(images: EmbedImageParams[]): Record<string, unknown>;

    private async embed(fields: Record<string, unknown>, count: number, signal?: AbortSignal): Promise<EmbeddingResult[]> {
        const response = await postJson<EmbeddingsResponse>(`${this.baseUrl}/embeddings`, {
            headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
            json: { model: this.modelName, ...fields },
            signal,
        });
        const items = [...(response.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (items.length !== count) {
            throw new AiProviderError("TRANSIENT", `Model '${this.modelName}' returned ${items.length} embeddings for ${count} inputs.`);
        }
        return items.map((item) => toEmbeddingResult(shortenMrlVector(item.embedding, this.capabilities), this.modelName, this.capabilities));
    }

    async embedText(params: EmbedTextParams): Promise<EmbeddingResult> {
        const [result] = await this.embedTexts([params], params.abortSignal);
        return result!;
    }

    async embedTexts(params: EmbedTextParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        return this.embed({ input: params.map((item) => formatEmbeddingText(item, this.capabilities)) }, params.length, abortSignal);
    }

    async embedImages(params: EmbedImageParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        return this.embed(this.imageRequestFields(params), params.length, abortSignal);
    }
}

/**
 * llama.cpp `llama-server --embeddings --mmproj …`: each `input` item is one embedding built from
 * typed content parts. The parts must be wrapped in `{ content: [...] }`; a bare part list is rejected.
 */
export class LlamaCppEmbeddingProvider extends SelfHostedEmbeddingProvider {
    readonly imageBatchSize = 4;

    protected imageRequestFields(images: EmbedImageParams[]) {
        return { input: images.map((image) => ({ content: [{ type: "image_url", image_url: { url: imageUrl(image) } }] })) };
    }
}

/**
 * vLLM pooling models: images ride in chat-style `messages` (the Chat Completions schema), and one
 * request is one conversation, so it yields one embedding.
 */
export class VllmEmbeddingProvider extends SelfHostedEmbeddingProvider {
    readonly imageBatchSize = 1;

    protected imageRequestFields(images: EmbedImageParams[]) {
        return { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: imageUrl(images[0]!) } }] }] };
    }
}
