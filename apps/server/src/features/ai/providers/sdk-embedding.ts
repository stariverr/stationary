import { embedMany, type EmbeddingModel } from "ai";
import type { EmbeddingModelCapabilities } from "../model-schema";
import type { EmbedTextParams, EmbeddingResult, ResolvedModelConfig, TextEmbeddingProvider } from "../types";
import { computeEmbeddingSpaceId, formatEmbeddingText, toEmbeddingResult, withTimeout } from "../utils";

/** Texts per request; below every SDK provider's own per-call limit, so one batch is one request. */
const SDK_TEXT_BATCH_SIZE = 64;
/** Upper bound of one batch request; the HTTP adapters use 30s for a single request. */
const SDK_EMBED_TIMEOUT_MS = 60_000;

/** Text embeddings through the AI SDK, shared by the adapters whose SDK covers embeddings. */
export class SdkTextEmbeddingProvider implements TextEmbeddingProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: EmbeddingModelCapabilities;
    readonly spaceId: string;
    readonly textBatchSize = SDK_TEXT_BATCH_SIZE;

    constructor(
        config: ResolvedModelConfig,
        private readonly embeddingModel: EmbeddingModel,
        private readonly providerOptions: Record<string, Record<string, number>> | undefined,
    ) {
        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = config.capabilities as EmbeddingModelCapabilities;
        this.spaceId = computeEmbeddingSpaceId(this.modelName, this.capabilities);
    }

    async embedText(params: EmbedTextParams): Promise<EmbeddingResult> {
        const [result] = await this.embedTexts([params], params.abortSignal);
        return result!;
    }

    async embedTexts(params: EmbedTextParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]> {
        const { embeddings } = await embedMany({
            model: this.embeddingModel,
            values: params.map((item) => formatEmbeddingText(item, this.capabilities)),
            maxRetries: 0,
            maxParallelCalls: 1,
            abortSignal: withTimeout(abortSignal, SDK_EMBED_TIMEOUT_MS),
            providerOptions: this.providerOptions,
        });
        return embeddings.map((embedding) => toEmbeddingResult(embedding, this.modelName, this.capabilities));
    }
}
