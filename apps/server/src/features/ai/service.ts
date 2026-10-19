import { IMAGE_METADATA_PROMPT_VERSION, describeImageWithModel } from "./image-metadata";
import { prepareImageForModel } from "./image-format";
import { resolveAiConfig } from "./resolver";
import { kv } from "@/global/kv";
import { AiConfigurationError } from "./errors";
import { createPromiseCache } from "./promise-cache";
import { computeSha256 } from "./utils";
import { createProviderLimiter, createRedisRateLimitStore } from "./rate-limit";
import type {
    DescribeTarget,
    EmbedImageParams,
    EmbedTextParams,
    EmbeddingBindingRole,
    EmbeddingResult,
    EmbeddingRoleProviders,
    ImageAiMetadata,
    LanguageProvider,
    RerankProvider,
    ResolvedAiConfig,
    TextEmbeddingProvider,
    VisualEmbeddingProvider,
} from "./types";

const providerLimiter = createProviderLimiter(createRedisRateLimitStore(kv));

/**
 * Recent query vectors, keyed by embedding space and query text. A vector depends only on the
 * space (model, dimension, template), never on the library or user, so entries are shared.
 * Holds in-flight promises too, so concurrent identical queries make one provider call.
 */
const queryEmbeddingCache = createPromiseCache<EmbeddingResult>(10 * 60 * 1000, 500);

/** Rerank scores per model, query and candidate list, so paging through results reranks once. */
const rerankCache = createPromiseCache<number[]>(10 * 60 * 1000, 200);

/**
 * How callers react to a provider at its rate limit:
 * - background: fail fast with AiThrottledError so the job system reschedules the unit;
 * - interactive: wait briefly, since a user is waiting for the result.
 */
export type AiCallMode = "background" | "interactive";
const MAX_WAIT_MS: Record<AiCallMode, number> = { background: 0, interactive: 3_000 };

export class AiService {
    constructor(
        readonly config: ResolvedAiConfig,
        private readonly mode: AiCallMode = "background",
    ) {}

    static async forLibrary(libraryId: string, mode: AiCallMode = "background"): Promise<AiService | null> {
        const resolved = await resolveAiConfig({ libraryId });
        if (!resolved) return null;
        return new AiService(resolved, mode);
    }

    private limited<T>(providerId: string, call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        const limits = this.config.limits[providerId];
        if (!limits) {
            throw new AiConfigurationError(`Provider ${providerId} has no resolved request limits.`);
        }
        return providerLimiter.run(providerId, limits, call, { maxWaitMs: MAX_WAIT_MS[this.mode], signal });
    }

    get describeProvider(): LanguageProvider | null {
        return this.config.describeProvider;
    }

    get textEmbedding(): EmbeddingRoleProviders<TextEmbeddingProvider> {
        return this.config.textEmbedding;
    }

    get imageEmbedding(): EmbeddingRoleProviders<VisualEmbeddingProvider> {
        return this.config.imageEmbedding;
    }

    get chatModelName(): string | null {
        return this.describeProvider?.modelName || null;
    }

    /**
     * What a description made now is generated with. A stored description of another prompt version
     * or language is regenerated; one of another model stays until re-describing is asked for.
     */
    get describeTarget(): DescribeTarget | null {
        const model = this.chatModelName;
        return model ? { model, promptVersion: IMAGE_METADATA_PROMPT_VERSION, language: this.config.language } : null;
    }

    /**
     * Embeds a search query in the active space of `role`. Query vectors are cached per space and
     * text, so roles sharing a space (one multimodal model) embed a query once, and paging through
     * results reuses it.
     */
    async embedQuery(role: EmbeddingBindingRole, text: string, abortSignal?: AbortSignal): Promise<EmbeddingResult> {
        const provider = this.config[role].active;
        if (!provider) {
            throw new AiConfigurationError(`No active ${role} space is configured for this library.`);
        }
        return queryEmbeddingCache.getOrCreate(`${provider.spaceId}\n${text}`, () =>
            this.limited(provider.providerId, () => provider.embedText({ text, purpose: "QUERY", abortSignal }), abortSignal),
        );
    }

    get rerankProvider(): RerankProvider | null {
        return this.config.rerankProvider;
    }

    /** Relevance scores of `documents` for `query`. Cached by document content, so an edited document is rescored. */
    async rerank(query: string, documents: string[], abortSignal?: AbortSignal): Promise<number[]> {
        const provider = this.config.rerankProvider;
        if (!provider) throw new AiConfigurationError("No rerank model is configured for this library.");
        const key = `${provider.providerId}\n${provider.modelName}\n${query}\n${await computeSha256(JSON.stringify(documents))}`;
        return rerankCache.getOrCreate(key, () =>
            this.limited(provider.providerId, () => provider.rerank(query, documents, abortSignal), abortSignal),
        );
    }

    /** Embeds documents in one provider request; `params.length` must not exceed `provider.textBatchSize`. */
    async embedDocuments(
        provider: TextEmbeddingProvider,
        params: EmbedTextParams[],
        abortSignal?: AbortSignal,
    ): Promise<EmbeddingResult[]> {
        return this.limited(provider.providerId, () => provider.embedTexts(params, abortSignal), abortSignal);
    }

    /** Embeds images in one provider request; `images.length` must not exceed `provider.imageBatchSize`. */
    async embedImages(
        provider: VisualEmbeddingProvider,
        images: EmbedImageParams[],
        abortSignal?: AbortSignal,
    ): Promise<EmbeddingResult[]> {
        const prepared = await Promise.all(
            images.map(async (image) => {
                const converted = await prepareImageForModel(image.imageBuffer, image.mimeType, provider.capabilities.imageFormats);
                return { imageBuffer: converted.image, mimeType: converted.mimeType };
            }),
        );
        return this.limited(provider.providerId, () => provider.embedImages(prepared, abortSignal), abortSignal);
    }

    async describeImage(image: Buffer | Uint8Array, mimeType: string = "image/jpeg", abortSignal?: AbortSignal): Promise<ImageAiMetadata> {
        const provider = this.describeProvider;
        if (!provider) {
            throw new AiConfigurationError("Image description provider is not configured for this library.");
        }
        const prepared = await prepareImageForModel(image, mimeType, provider.capabilities.imageFormats);
        return this.limited(
            provider.providerId,
            () =>
                describeImageWithModel(provider.chatModel, prepared.image, prepared.mimeType, this.config.language, {
                    ...provider.describeOptions,
                    abortSignal,
                }),
            abortSignal,
        );
    }
}
