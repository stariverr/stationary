import type { AiModelCapabilities, AiModelCategory, EmbeddingDimension } from "../model-schema";

/** A model definition offered when adding a model; saving it stores a copy of `capabilities`. */
export interface CatalogModel {
    name: string;
    displayName: string;
    category: AiModelCategory;
    capabilities: AiModelCapabilities;
    /** Embedding models only: indexable output dimensions the model supports. */
    supportedDimensions?: EmbeddingDimension[];
    releaseDate?: string | null;
}

/** The generated catalog: the models each catalog provider serves, as that provider serves them. */
export interface CatalogData {
    providers: Record<string, CatalogModel[]>;
}

/** Gateways prefix ids with a vendor namespace (`google/gemini-3-flash`) and vary their case. */
export function normalizeModelId(id: string): string {
    const trimmed = id.trim().toLowerCase();
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
