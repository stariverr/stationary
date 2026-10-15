import { AiModel, AiProvider, DeleteStatus, Library, LibraryEmbeddingSpace, LibraryEmbeddingSpaceStatus } from "@/db/schema";
import { db } from "@/global/db";
import { and, eq, inArray } from "drizzle-orm";
import { secretBox } from "@/global/secrets";
import { AiConfigurationError, getSafeAiErrorMessage } from "./errors";
import { adapterSupportsModel, getProviderTemplate } from "./provider-templates";
import { parseModelCapabilities, supportsAiBindingRole, type AiBindingRole, type AiModelCategory, type RoleBinding } from "./model-schema";
import { buildLanguageProvider, buildRerankProvider, buildTextEmbeddingProvider, buildVisualEmbeddingProvider } from "./providers";
import type { ProviderLimits } from "./rate-limit";
import type { AiConfigIssue, EmbeddingBindingRole, ResolvedAiConfig, ResolvedModelConfig } from "./types";

/**
 * Resolves a role binding for a library owned by `ownerId`. A library may only use providers
 * that belong to its own owner (docs/ownership_and_teams.md).
 */
export async function resolveBindingConfig(
    binding: RoleBinding,
    expectedCategory: AiModelCategory,
    ownerId: string,
    role?: AiBindingRole,
): Promise<ResolvedModelConfig | null> {
    const rows = await db
        .select({ model: AiModel, provider: AiProvider })
        .from(AiModel)
        .innerJoin(AiProvider, eq(AiModel.provider_id, AiProvider.id))
        .where(eq(AiModel.id, binding.modelId))
        .limit(1);
    const row = rows[0];
    if (!row) return null;
    const { model, provider } = row;
    if (provider.owner_id !== ownerId) {
        throw new AiConfigurationError(`Provider '${provider.name}' does not belong to the library owner.`);
    }
    const template = getProviderTemplate(provider.template_id);
    if (!template) {
        throw new AiConfigurationError(`Provider '${provider.name}' uses an unknown template '${provider.template_id}'.`);
    }

    const actualCategory = model.category;
    if (actualCategory !== expectedCategory) {
        throw new AiConfigurationError(`Model '${model.name}' cannot be used for the ${expectedCategory} role.`);
    }

    const capabilities = parseModelCapabilities(actualCategory, model.capabilities);
    if (!capabilities) {
        throw new AiConfigurationError(`Model '${model.name}' has invalid ${actualCategory} capabilities.`);
    }
    if (role && !supportsAiBindingRole(role, capabilities)) {
        throw new AiConfigurationError(`Model '${model.name}' does not support the '${role}' role.`);
    }

    if (!adapterSupportsModel(template.adapter, actualCategory, capabilities)) {
        throw new AiConfigurationError(`Provider '${provider.name}' cannot serve model '${model.name}'.`);
    }

    return {
        providerId: provider.id,
        limits: { maxConcurrency: provider.max_concurrency, requestsPerMinute: provider.requests_per_minute },
        providerName: provider.name,
        adapter: template.adapter,
        baseUrl: provider.base_url,
        apiKey: provider.api_key_ciphertext ? secretBox.decrypt(provider.api_key_ciphertext) : "",
        modelName: model.name,
        category: actualCategory,
        capabilities,
    };
}

/**
 * Resolves the providers of every role a library has configured. Returns null when the library
 * configures no AI at all. A bound model that cannot be used leaves its role empty and is reported
 * in `issues`, so callers degrade without failing and can tell users why.
 */
export async function resolveAiConfig(target: { libraryId: string }): Promise<ResolvedAiConfig | null> {
    const libraryRows = await db
        .select({ owner_id: Library.owner_id, ai_bindings: Library.ai_bindings, ai_language: Library.ai_language })
        .from(Library)
        .where(and(eq(Library.id, target.libraryId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    const library = libraryRows[0];
    if (!library) return null;

    // RETIRED spaces are kept for switching back only; they are neither searched nor written.
    const spaces = await db
        .select()
        .from(LibraryEmbeddingSpace)
        .where(
            and(
                eq(LibraryEmbeddingSpace.library_id, target.libraryId),
                inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
            ),
        );
    const bindings = library.ai_bindings;
    if (!bindings?.describe?.modelId && !bindings?.rerank?.modelId && spaces.length === 0) return null;

    const limits: Record<string, ProviderLimits> = {};
    const issues: AiConfigIssue[] = [];

    async function resolveModel<T>(
        modelId: string | undefined,
        role: AiBindingRole,
        category: AiModelCategory,
        build: (config: ResolvedModelConfig) => T,
        building = false,
    ): Promise<T | null> {
        if (!modelId) return null;
        try {
            const config = await resolveBindingConfig({ modelId }, category, library.owner_id, role);
            if (!config) throw new AiConfigurationError(`The ${role} model no longer exists.`);
            limits[config.providerId] = config.limits;
            return build(config);
        } catch (error) {
            console.error(`[AI CONFIG] Ignoring invalid ${role} model for library ${target.libraryId}:`, error);
            issues.push({ role, building, message: getSafeAiErrorMessage(error) });
            return null;
        }
    }

    /** Embedding roles are served from the library's spaces, not directly from the bindings. */
    async function resolveSpace<P extends { spaceId: string }>(
        role: EmbeddingBindingRole,
        status: LibraryEmbeddingSpaceStatus,
        build: (config: ResolvedModelConfig) => P,
    ): Promise<P | null> {
        const space = spaces.find((row) => row.role === role && row.status === status);
        const building = status === LibraryEmbeddingSpaceStatus.BUILDING;
        const provider = await resolveModel(space?.model_id, role, "embedding", build, building);
        if (provider && provider.spaceId !== space?.space_id) {
            const message = `The model of ${role} space ${space?.space_id} now produces ${provider.spaceId}.`;
            console.error(`[AI CONFIG] ${message} Ignoring it.`);
            issues.push({ role, building, message });
            return null;
        }
        return provider;
    }

    const [describeProvider, rerankProvider, activeText, buildingText, activeImage, buildingImage] = await Promise.all([
        resolveModel(bindings?.describe?.modelId, "describe", "generation", buildLanguageProvider),
        resolveModel(bindings?.rerank?.modelId, "rerank", "rerank", buildRerankProvider),
        resolveSpace("textEmbedding", LibraryEmbeddingSpaceStatus.ACTIVE, buildTextEmbeddingProvider),
        resolveSpace("textEmbedding", LibraryEmbeddingSpaceStatus.BUILDING, buildTextEmbeddingProvider),
        resolveSpace("imageEmbedding", LibraryEmbeddingSpaceStatus.ACTIVE, buildVisualEmbeddingProvider),
        resolveSpace("imageEmbedding", LibraryEmbeddingSpaceStatus.BUILDING, buildVisualEmbeddingProvider),
    ]);

    return {
        language: library.ai_language,
        describeProvider,
        rerankProvider,
        textEmbedding: { active: activeText, building: buildingText },
        imageEmbedding: { active: activeImage, building: buildingImage },
        limits,
        issues,
    };
}
