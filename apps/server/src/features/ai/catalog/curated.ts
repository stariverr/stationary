import type { EmbeddingDimension, EmbeddingModelCapabilities, GeneratedTextModelCapabilities } from "../model-schema";

/**
 * Hand-maintained catalog data. `bun run generate:model-catalog` merges it over models.dev
 * into catalog.json, the only catalog read at runtime; rerun it after editing this file.
 */

export interface CuratedEmbeddingModel {
    /** Catalog provider whose API serves this model under `name`. */
    catalogProviderId: string;
    name: string;
    displayName: string;
    /** Indexable output dimensions the model can return; `capabilities.dimension` is the default. */
    supportedDimensions: EmbeddingDimension[];
    capabilities: EmbeddingModelCapabilities;
}

/**
 * Embedding models are maintained here because public catalogs (models.dev) lack the fields
 * an index depends on: output dimensions, MRL support and query/document templates.
 * Only models whose wire format the adapters implement are listed.
 */
export const CURATED_EMBEDDING_MODELS: CuratedEmbeddingModel[] = [
    {
        catalogProviderId: "google",
        name: "gemini-embedding-2",
        displayName: "Gemini Embedding 2",
        supportedDimensions: [256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072],
        capabilities: {
            dimension: 768,
            mrl: true,
            maxInputTokens: 8192,
            multimodal: true,
            imageFormats: ["image/png", "image/jpeg"],
            taskPrefixType: "gemini-asymmetric",
        },
    },
    {
        catalogProviderId: "alibaba-cn",
        name: "qwen3-vl-embedding",
        displayName: "Qwen3-VL Embedding",
        supportedDimensions: [256, 512, 768, 1024, 1536, 2048, 2560],
        capabilities: {
            dimension: 1024,
            mrl: true,
            maxInputTokens: 32000,
            multimodal: true,
            imageFormats: ["image/jpeg", "image/png", "image/webp"],
        },
    },
    {
        catalogProviderId: "alibaba-cn",
        name: "text-embedding-v4",
        displayName: "Qwen Text Embedding v4",
        supportedDimensions: [256, 512, 768, 1024, 1536, 2048],
        capabilities: {
            dimension: 1024,
            mrl: true,
            maxInputTokens: 8192,
            multimodal: false,
        },
    },
    {
        catalogProviderId: "openai",
        name: "text-embedding-3-large",
        displayName: "OpenAI text-embedding-3-large",
        supportedDimensions: [256, 384, 512, 768, 1024, 1536, 2048, 2560, 3072],
        capabilities: {
            dimension: 1536,
            mrl: true,
            maxInputTokens: 8191,
            multimodal: false,
        },
    },
    {
        catalogProviderId: "openai",
        name: "text-embedding-3-small",
        displayName: "OpenAI text-embedding-3-small",
        supportedDimensions: [256, 384, 512, 768, 1024, 1536],
        capabilities: {
            dimension: 1536,
            mrl: true,
            maxInputTokens: 8191,
            multimodal: false,
        },
    },
];

/**
 * Corrections to models.dev generation definitions, keyed by catalog provider and model id.
 * Each patch is merged over the generated capabilities.
 */
export const GENERATION_MODEL_PATCHES: Record<string, Record<string, Partial<GeneratedTextModelCapabilities>>> = {};

/**
 * Generation models released before this date are left out: their successors are better and
 * many have reached end of life. Raise it from time to time; curated embeddings are exempt.
 */
export const MIN_RELEASE_DATE = "2025-06-01";

/**
 * Generation models left out although they pass the automatic rules (deprecation upstream, the
 * release date floor, newest version per product line): end-of-life models models.dev still
 * lists, and lines replaced by a differently named one. Normalized ids; a trailing `*` matches
 * a prefix.
 */
export const RETIRED_MODELS: string[] = [
    // OpenAI's o-series reasoning models, replaced by GPT-5.
    "o1*",
    "o3*",
    "o4*",
];
