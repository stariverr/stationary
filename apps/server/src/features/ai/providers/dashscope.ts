import type { EmbeddingModelCapabilities } from "../model-schema";
import type { EmbedImageParams, EmbedTextParams, EmbeddingResult, ResolvedModelConfig, VisualEmbeddingProvider } from "../types";
import { AiProviderError } from "../errors";
import { computeEmbeddingSpaceId, formatEmbeddingText, toEmbeddingResult } from "../utils";
import { postJson } from "./http";

/** One element of `input.contents`; each element yields its own vector unless fusion is enabled. */
type DashScopeContent = { text: string } | { image: string };

interface DashScopeEmbeddingResponse {
    output?: { embeddings?: Array<{ index?: number; embedding: number[] }> };
}

/**
 * Aliyun DashScope multimodal embedding (qwen3-vl-embedding-*) is only exposed on the native
 * API, not on the OpenAI-compatible endpoint. Text and images both go through it, which also
 * guarantees they land in the same vector space.
 */
export class DashScopeMultimodalEmbeddingProvider implements VisualEmbeddingProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: EmbeddingModelCapabilities;
    readonly spaceId: string;
    /** The API accepts at most 20 contents per request. */
    readonly textBatchSize = 20;
    /**
     * Several images in one request may be fused into one vector by multimodal models,
     * so images are sent one per request.
     */
    readonly imageBatchSize = 1;
    private readonly apiKey: string;
    private readonly baseUrl: string;

    constructor(config: ResolvedModelConfig) {
        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = config.capabilities as EmbeddingModelCapabilities;
        this.spaceId = computeEmbeddingSpaceId(this.modelName, this.capabilities);
        this.apiKey = config.apiKey;
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
    }

    private async embed(contents: DashScopeContent[], signal?: AbortSignal): Promise<EmbeddingResult[]> {
        const host = this.baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        const url = `https://${host}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`;
        const resJson = await postJson<DashScopeEmbeddingResponse>(url, {
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
            json: {
                model: this.modelName,
                input: { contents },
                ...(this.capabilities.mrl ? { parameters: { dimension: this.capabilities.dimension } } : {}),
            },
            signal,
        });

        const embeddings = [...(resJson?.output?.embeddings ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        if (embeddings.length !== contents.length) {
            throw new AiProviderError(
                "TRANSIENT",
                `Model '${this.modelName}' returned ${embeddings.length} embeddings for ${contents.length} inputs.`,
            );
        }
        return embeddings.map((item) => toEmbeddingResult(item.embedding, this.modelName, this.capabilities));
    }

    async embedText(params: EmbedTextParams): Promise<EmbeddingResult> {
        const [result] = await this.embedTexts([params], params.abortSignal);
        return result!;
    }

    async embedTexts(params: EmbedTextParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        return this.embed(
            params.map((item) => ({ text: formatEmbeddingText(item, this.capabilities) })),
            abortSignal,
        );
    }

    async embedImages(params: EmbedImageParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        const results: EmbeddingResult[] = [];
        for (const image of params) {
            const [result] = await this.embed(
                [{ image: `data:${image.mimeType};base64,${Buffer.from(image.imageBuffer).toString("base64")}` }],
                abortSignal,
            );
            results.push(result!);
        }
        return results;
    }
}
