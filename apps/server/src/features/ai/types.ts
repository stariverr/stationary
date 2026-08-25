import type { EmbeddingModel, LanguageModel } from "ai";

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
}

export interface EmbedImageParams {
    imageBuffer: Buffer | Uint8Array;
    mimeType: string;
}

export interface AiProvider {
    readonly id: string;
    readonly providerName: string;
    readonly chatModel: LanguageModel | null;
    readonly chatModelName: string | null;
    readonly textEmbeddingModel: EmbeddingModel | null;
    readonly textEmbeddingModelName: string | null;
    readonly visualEmbeddingModel: EmbeddingModel | null;
    readonly visualEmbeddingModelName: string | null;
    embedImage(params: EmbedImageParams): Promise<EmbeddingResult>;
    embedTextWithVisualModel?(params: EmbedTextParams): Promise<EmbeddingResult>;
}

export interface AiProviderModelMappings {
    describeImageMapTo?: string | null;
    embeddingTextMapTo?: string | null;
    embeddingImageMapTo?: string | null;
}

export interface ResolvedAiProvider {
    provider: AiProvider;
    mappings: AiProviderModelMappings;
}
