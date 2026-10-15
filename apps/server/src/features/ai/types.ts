import type { LanguageModel } from "ai";
import type { ProviderLimits } from "./rate-limit";
import type {
    AiBindingRole,
    AiModelCapabilities,
    AiModelCategory,
    AiProviderAdapter,
    EmbeddingModelCapabilities,
    GeneratedTextModelCapabilities,
    ReasoningLevel,
    RerankModelCapabilities,
} from "./model-schema";

export type EmbeddingPurpose = "QUERY" | "DOCUMENT";

export interface ImageAiMetadata {
    caption: string;
    tags: string[];
    objects: string[];
    colors: string[];
    styles: string[];
    scene: string;
    ocrText: string;
}

export interface EmbeddingResult {
    embedding: number[];
    spaceId: string;
    dimension: number;
}

export interface EmbedTextParams {
    text: string;
    purpose: EmbeddingPurpose;
    title?: string;
    abortSignal?: AbortSignal;
}

export interface EmbedImageParams {
    imageBuffer: Buffer | Uint8Array;
    mimeType: string;
    abortSignal?: AbortSignal;
}

export interface ResolvedModelConfig {
    providerId: string;
    limits: ProviderLimits;
    providerName: string;
    adapter: AiProviderAdapter;
    baseUrl: string;
    apiKey: string;
    modelName: string;
    category: AiModelCategory;
    capabilities: AiModelCapabilities;
}

/** Request knobs for image description, decided by each language provider implementation. */
export interface DescribeImageRequestOptions {
    maxOutputTokens?: number;
    reasoning?: ReasoningLevel;
    providerOptions?: Record<string, Record<string, unknown>>;
    strictJsonSchema?: boolean;
    abortSignal?: AbortSignal;
}

export interface LanguageProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly chatModel: LanguageModel;
    readonly capabilities: GeneratedTextModelCapabilities;
    readonly describeOptions: DescribeImageRequestOptions;
}

export interface TextEmbeddingProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: EmbeddingModelCapabilities;
    /** Vector space of every embedding this provider returns; see computeEmbeddingSpaceId. */
    readonly spaceId: string;
    /** Most texts one embedTexts request may carry. */
    readonly textBatchSize: number;
    embedText(params: EmbedTextParams): Promise<EmbeddingResult>;
    /** Embeds several texts in one provider request; results keep the input order. */
    embedTexts(params: EmbedTextParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]>;
}

export interface VisualEmbeddingProvider extends TextEmbeddingProvider {
    /** Most images one embedImages request may carry. */
    readonly imageBatchSize: number;
    /** Embeds several images in one provider request; results keep the input order. */
    embedImages(params: EmbedImageParams[], abortSignal?: AbortSignal): Promise<EmbeddingResult[]>;
}

/** Scores (query, document) pairs; used to reorder the top search candidates. */
export interface RerankProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: RerankModelCapabilities;
    /** Relevance score per document, in input order; higher is more relevant. */
    rerank(query: string, documents: string[], abortSignal?: AbortSignal): Promise<number[]>;
}

export type EmbeddingBindingRole = "textEmbedding" | "imageEmbedding";

/**
 * Providers of a library's embedding spaces for one role. Search queries `active`; enrichment
 * writes to both so a `building` space catches up while the active one keeps serving.
 */
export interface EmbeddingRoleProviders<P> {
    active: P | null;
    building: P | null;
}

/** A bound model that could not be used; the role is left out of the resolved config. */
export interface AiConfigIssue {
    role: AiBindingRole;
    /** True when the model serves a BUILDING embedding space, which search does not use yet. */
    building: boolean;
    message: string;
}

/** The most recent error of a role's background work, for display. */
export interface AiErrorView {
    message: string;
    /** ISO timestamp of when it was recorded. */
    at: string;
}

export interface ResolvedAiConfig {
    /** Library language for image descriptions (BCP 47). */
    language: string;
    describeProvider: LanguageProvider | null;
    rerankProvider: RerankProvider | null;
    textEmbedding: EmbeddingRoleProviders<TextEmbeddingProvider>;
    imageEmbedding: EmbeddingRoleProviders<VisualEmbeddingProvider>;
    /** Request limits of every resolved provider, keyed by provider id. */
    limits: Record<string, ProviderLimits>;
    /** Bound models that could not be resolved. */
    issues: AiConfigIssue[];
}
