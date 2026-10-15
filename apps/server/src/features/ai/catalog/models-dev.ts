import * as v from "valibot";
import { AI_REASONING_LEVELS, AiModalitySchema, parseModelCapabilities, type ReasoningLevel } from "../model-schema";
import { AI_PROVIDER_TEMPLATES } from "../provider-templates";
import { CURATED_EMBEDDING_MODELS, GENERATION_MODEL_PATCHES } from "./curated";
import { dropSupersededModels, isRetiredModel } from "./lifecycle";
import { normalizeModelId, type CatalogData, type CatalogModel } from "./types";
import { MODEL_VENDORS, findModelVendor } from "./vendors";

export const MODELS_DEV_URL = "https://models.dev/api.json";

/** Accepted by every mapped vision API; used when the model's vendor documents no list. */
const DEFAULT_IMAGE_FORMATS = ["image/jpeg", "image/png", "image/webp"];

const ModelsDevModelSchema = v.object({
    id: v.string(),
    name: v.optional(v.string()),
    family: v.optional(v.nullable(v.string())),
    status: v.optional(v.nullable(v.string())),
    release_date: v.optional(v.nullable(v.string())),
    structured_output: v.optional(v.nullable(v.boolean())),
    reasoning_options: v.optional(
        v.nullable(v.array(v.object({ type: v.string(), values: v.optional(v.array(v.string())) }))),
    ),
    modalities: v.optional(
        v.object({
            input: v.optional(v.array(v.string()), []),
            output: v.optional(v.array(v.string()), []),
        }),
    ),
    limit: v.optional(
        v.object({
            context: v.optional(v.nullable(v.number())),
            output: v.optional(v.nullable(v.number())),
        }),
    ),
});
type ModelsDevModel = v.InferOutput<typeof ModelsDevModelSchema>;

const knownModalities = new Set<string>(AiModalitySchema.options);

/**
 * The model's reasoning effort levels the AI SDK can request, in SDK order. Toggle- and
 * budget-only models get none: the SDK's levels do not map onto them reliably.
 */
function reasoningLevels(model: ModelsDevModel): ReasoningLevel[] {
    const efforts = new Set(model.reasoning_options?.flatMap((option) => (option.type === "effort" ? (option.values ?? []) : [])));
    return AI_REASONING_LEVELS.filter((level) => efforts.has(level));
}

/** Describing images needs little reasoning: prefer the cheapest level that still thinks. */
function defaultReasoning(levels: ReasoningLevel[]): ReasoningLevel | undefined {
    return levels.find((level) => level === "low") ?? levels.find((level) => level === "minimal");
}

/**
 * Maps a models.dev entry to a generation definition. Text-only models are kept so a lookup
 * can tell that a model cannot see images; models that generate images or audio (image, music
 * and realtime voice models) are not chat models, and embedding and rerank entries are curated.
 */
export function toGenerationCatalogModel(model: ModelsDevModel, patch?: object): CatalogModel | null {
    if (model.status === "deprecated") return null;
    if (/embed|rerank/i.test(`${model.id} ${model.family ?? ""}`)) return null;
    const input = model.modalities?.input ?? [];
    const output = model.modalities?.output ?? [];
    if (!input.includes("text") || output.length === 0 || output.some((modality) => modality !== "text")) return null;

    const outputLimit = model.limit?.output;
    const inputModalities = input.filter((modality) => knownModalities.has(modality));
    const levels = reasoningLevels(model);
    const reasoning = defaultReasoning(levels);
    const capabilities = parseModelCapabilities("generation", {
        contextWindow: model.limit?.context,
        ...(outputLimit && outputLimit > 0 ? { maxOutputTokens: outputLimit } : {}),
        inputModalities,
        ...(inputModalities.includes("image")
            ? { imageFormats: findModelVendor(normalizeModelId(model.id))?.imageFormats ?? DEFAULT_IMAGE_FORMATS }
            : {}),
        structuredOutput: model.structured_output === true,
        ...(levels.length > 0 ? { reasoningLevels: levels } : {}),
        ...(reasoning ? { reasoning } : {}),
        ...patch,
    });
    if (!capabilities) return null;

    return {
        name: model.id,
        displayName: model.name || model.id,
        category: "generation",
        capabilities,
        releaseDate: model.release_date || null,
    };
}

/** Catalog providers: every vendor's own listing plus the providers templates connect to. */
export function catalogProviderIds(): string[] {
    const ids = [
        ...MODEL_VENDORS.map((vendor) => vendor.catalogProviderId),
        ...AI_PROVIDER_TEMPLATES.flatMap((template) => (template.catalogProviderId ? [template.catalogProviderId] : [])),
    ];
    return [...new Set(ids)].sort();
}

/**
 * Builds the catalog from a models.dev snapshot with the curated data merged over it, leaving
 * out deprecated, retired and superseded generation models (see lifecycle.ts).
 */
export function buildCatalog(modelsDev: Record<string, unknown>): CatalogData {
    const providers: CatalogData["providers"] = {};

    for (const providerId of catalogProviderIds()) {
        const listing = modelsDev[providerId];
        if (!listing || typeof listing !== "object" || !("models" in listing) || !listing.models || typeof listing.models !== "object") {
            throw new Error(`models.dev has no provider '${providerId}'; update the vendors or templates that reference it.`);
        }
        const patches = GENERATION_MODEL_PATCHES[providerId] ?? {};
        const curated = CURATED_EMBEDDING_MODELS.filter((model) => model.catalogProviderId === providerId);
        const curatedIds = new Set(curated.map((model) => normalizeModelId(model.name)));

        const generated = dropSupersededModels(
            Object.values(listing.models)
                .map((entry) => v.safeParse(ModelsDevModelSchema, entry))
                .flatMap((result) => (result.success ? [toGenerationCatalogModel(result.output, patches[result.output.id])] : []))
                .filter((model): model is CatalogModel => model !== null && !isRetiredModel(model)),
        ).filter((model) => !curatedIds.has(normalizeModelId(model.name)));

        providers[providerId] = [
            ...generated,
            ...curated.map(
                (model): CatalogModel => ({
                    name: model.name,
                    displayName: model.displayName,
                    category: "embedding",
                    capabilities: model.capabilities,
                    supportedDimensions: model.supportedDimensions,
                }),
            ),
        ].sort((a, b) => a.name.localeCompare(b.name));
    }
    return { providers };
}
