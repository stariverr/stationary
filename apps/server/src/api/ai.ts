import { Hono, type Context } from "hono";
import * as v from "valibot";
import { and, eq, sql } from "drizzle-orm";
import { AiModel, AiProvider, DeleteStatus, Library } from "@/db/schema";
import { getProviderCatalog, matchCatalogModels } from "@/features/ai/catalog";
import { retryFailedEmbeddings } from "@/features/ai/embedding-queue";
import { queueLibraryAiEnrichment } from "@/features/ai/queue-enrichment";
import { clearModelBindings, getLibraryBindings, getRolesUsingModel, saveLibraryBindings } from "@/features/ai/bindings";
import { restartStalledBackfills } from "@/features/ai/embedding-spaces";
import { getLibraryAiStatus, getLibraryDescribeStatus } from "@/features/ai/status";
import { classifyAiError, getSafeAiErrorMessage } from "@/features/ai/errors";
import { UpdateLibraryAiBindingsSchema } from "@/features/ai/schema";
import {
    AiModelCategorySchema,
    parseModelCapabilities,
    supportsAiBindingRole,
    type AiBindingRole,
    type AiModelCategory,
    type EmbeddingModelCapabilities,
} from "@/features/ai/model-schema";
import { computeEmbeddingSpaceId } from "@/features/ai/utils";
import { AI_PROVIDER_TEMPLATES, adapterSupportsModel, getProviderTemplate } from "@/features/ai/provider-templates";
import { probeModel, summarizeProbeFailures } from "@/features/ai/probe";
import { listProviderModels } from "@/features/ai/providers/connection";
import { assertAllowedEndpoint } from "@/features/ai/providers/egress";
import { resolveBindingConfig } from "@/features/ai/resolver";
import { db } from "@/global/db";
import { secretBox } from "@/global/secrets";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { validate } from "@/lib/validation/validator";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";

/**
 * AI configuration is split by ownership (docs/ownership_and_teams.md):
 * - providers and models belong to the account that owns libraries;
 * - each library only stores which of its owner's models fill each role.
 */
export const aiRouter = new Hono<AuthEnv>();

type AiContext = Context<AuthEnv>;
type ProviderRow = typeof AiProvider.$inferSelect;

/** Account-level AI resources cannot be reached with a library-scoped API token. */
function requireAccountUser(c: AiContext) {
    const user = c.get("user");
    if (!user) return { denied: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401) };
    if (c.get("apiToken")?.library_id) {
        return { denied: c.json(error(Code.FORBIDDEN, "Library-scoped API tokens cannot manage AI providers"), 403) };
    }
    return { user };
}

async function loadOwnedLibrary(c: AiContext, libraryId: string) {
    const user = c.get("user");
    if (!user) return { denied: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401) };

    const rows = await db
        .select()
        .from(Library)
        .where(and(eq(Library.id, libraryId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    const library = rows[0];
    if (!library) return { denied: c.json(error(Code.NOT_FOUND, "Library not found"), 404) };
    if (library.owner_id !== user.id) return { denied: c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403) };

    const scopedLibraryId = c.get("apiToken")?.library_id;
    if (scopedLibraryId && scopedLibraryId !== libraryId) {
        return { denied: c.json(error(Code.FORBIDDEN, "API token scope restricted to another library"), 403) };
    }
    return { library };
}

async function loadOwnedProvider(c: AiContext, providerId: string) {
    const access = requireAccountUser(c);
    if (access.denied) return access;
    const rows = await db
        .select()
        .from(AiProvider)
        .where(and(eq(AiProvider.id, providerId), eq(AiProvider.owner_id, access.user.id)))
        .limit(1);
    const provider = rows[0];
    if (!provider) return { denied: c.json(error(Code.NOT_FOUND, "Provider not found"), 404) };
    return { user: access.user, provider };
}

function decryptApiKey(provider: ProviderRow): string {
    return provider.api_key_ciphertext ? secretBox.decrypt(provider.api_key_ciphertext) : "";
}

/** Providers are returned with a key hint only; the key itself never leaves the server. */
function toProviderResponse(provider: ProviderRow) {
    let apiKeyHint: string | null = null;
    if (provider.api_key_ciphertext) {
        try {
            const key = secretBox.decrypt(provider.api_key_ciphertext);
            apiKeyHint = key.length > 8 ? `••••${key.slice(-4)}` : "••••";
        } catch (err) {
            console.error(`[AI] Cannot decrypt the API key of provider ${provider.id}; was SECRETS_ENCRYPTION_KEY changed?`, err);
            apiKeyHint = "unreadable";
        }
    }
    return {
        id: provider.id,
        template_id: provider.template_id,
        name: provider.name,
        base_url: provider.base_url,
        api_key_hint: apiKeyHint,
        max_concurrency: provider.max_concurrency,
        requests_per_minute: provider.requests_per_minute,
        create_time: provider.create_time,
        update_time: provider.update_time,
    };
}

/** Rejects base URLs the server must not request (see providers/egress.ts); returns the reason, or null. */
async function checkBaseUrl(baseUrl: string): Promise<string | null> {
    try {
        await assertAllowedEndpoint(baseUrl);
        return null;
    } catch (err) {
        return getSafeAiErrorMessage(err);
    }
}

const TemplateIdSchema = v.pipe(
    v.string(),
    v.check((id) => getProviderTemplate(id) !== null, "Unknown provider template"),
);
const IdParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid("Invalid ID")),
});

// Provider templates: connection presets.
aiRouter.get("/provider-templates", requireAuth, async (c) => {
    return c.json(success(Code.SUCCESS, AI_PROVIDER_TEMPLATES));
});

// Providers of the current account.
aiRouter.get("/providers", requireAuth, async (c) => {
    const access = requireAccountUser(c);
    if (access.denied) return access.denied;

    const providers = await db.select().from(AiProvider).where(eq(AiProvider.owner_id, access.user.id)).orderBy(AiProvider.create_time);
    return c.json(success(Code.SUCCESS, providers.map(toProviderResponse)));
});

const MaxConcurrencySchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(256));
const RequestsPerMinuteSchema = v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)));

const CreateProviderBodySchema = v.object({
    template_id: TemplateIdSchema,
    name: v.pipe(v.string(), v.trim(), v.nonEmpty("Provider name is required")),
    base_url: v.pipe(v.string(), v.trim(), v.url("Base URL must be a valid URL")),
    api_key: v.optional(v.pipe(v.string(), v.trim())),
    max_concurrency: v.optional(MaxConcurrencySchema),
    requests_per_minute: v.optional(RequestsPerMinuteSchema),
});

aiRouter.post("/providers", requireAuth, validate("json", CreateProviderBodySchema), async (c) => {
    const access = requireAccountUser(c);
    if (access.denied) return access.denied;
    const body = c.req.valid("json");
    const baseUrlProblem = await checkBaseUrl(body.base_url);
    if (baseUrlProblem) return c.json(error(Code.INVALID_PARAMETER, baseUrlProblem), 400);

    const [provider] = await db
        .insert(AiProvider)
        .values({
            owner_id: access.user.id,
            template_id: body.template_id,
            name: body.name,
            base_url: body.base_url,
            api_key_ciphertext: body.api_key ? secretBox.encrypt(body.api_key) : null,
            ...(body.max_concurrency !== undefined ? { max_concurrency: body.max_concurrency } : {}),
            requests_per_minute: body.requests_per_minute ?? null,
        })
        .returning();

    return c.json(success(Code.SUCCESS, toProviderResponse(provider)));
});

const UpdateProviderBodySchema = v.object({
    template_id: v.optional(TemplateIdSchema),
    name: v.optional(v.pipe(v.string(), v.trim(), v.nonEmpty())),
    base_url: v.optional(v.pipe(v.string(), v.trim(), v.url("Base URL must be a valid URL"))),
    /** Omit to keep the stored key, send a string to replace it, or null to remove it. */
    api_key: v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
    max_concurrency: v.optional(MaxConcurrencySchema),
    requests_per_minute: v.optional(RequestsPerMinuteSchema),
});

aiRouter.put("/providers/:id", requireAuth, validate("param", IdParamSchema), validate("json", UpdateProviderBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const access = await loadOwnedProvider(c, id);
    if (access.denied) return access.denied;

    if (body.base_url) {
        const baseUrlProblem = await checkBaseUrl(body.base_url);
        if (baseUrlProblem) return c.json(error(Code.INVALID_PARAMETER, baseUrlProblem), 400);
    }

    if (body.template_id && body.template_id !== access.provider.template_id) {
        const adapter = getProviderTemplate(body.template_id)!.adapter;
        const models = await db
            .select({ category: AiModel.category, capabilities: AiModel.capabilities })
            .from(AiModel)
            .where(eq(AiModel.provider_id, id));
        const incompatible = models.some((model) => {
            const capabilities = parseModelCapabilities(model.category, model.capabilities);
            return !capabilities || !adapterSupportsModel(adapter, model.category, capabilities);
        });
        if (incompatible) {
            return c.json(error(Code.INVALID_PARAMETER, "The selected template cannot serve all models of this provider"), 400);
        }
    }

    const [updated] = await db
        .update(AiProvider)
        .set({
            ...(body.template_id ? { template_id: body.template_id } : {}),
            ...(body.name ? { name: body.name } : {}),
            ...(body.base_url ? { base_url: body.base_url } : {}),
            ...(body.api_key !== undefined ? { api_key_ciphertext: body.api_key ? secretBox.encrypt(body.api_key) : null } : {}),
            ...(body.max_concurrency !== undefined ? { max_concurrency: body.max_concurrency } : {}),
            ...(body.requests_per_minute !== undefined ? { requests_per_minute: body.requests_per_minute } : {}),
            update_time: sql`now()`,
        })
        .where(eq(AiProvider.id, id))
        .returning();

    return c.json(success(Code.SUCCESS, toProviderResponse(updated)));
});

aiRouter.delete("/providers/:id", requireAuth, validate("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = await loadOwnedProvider(c, id);
    if (access.denied) return access.denied;

    const models = await db.select({ id: AiModel.id }).from(AiModel).where(eq(AiModel.provider_id, id));
    await db.transaction(async (tx) => {
        await clearModelBindings(
            tx,
            access.user.id,
            models.map((model) => model.id),
        );
        await tx.delete(AiModel).where(eq(AiModel.provider_id, id));
        await tx.delete(AiProvider).where(eq(AiProvider.id, id));
    });

    return c.json(success(Code.SUCCESS, null, "Provider deleted successfully"));
});

// Connection test: lists the provider's models with the stored credential.
aiRouter.post("/providers/:id/test", requireAuth, validate("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = await loadOwnedProvider(c, id);
    if (access.denied) return access.denied;

    const template = getProviderTemplate(access.provider.template_id);
    if (!template) {
        return c.json(error(Code.INVALID_PARAMETER, `Unknown provider template '${access.provider.template_id}'`), 400);
    }

    try {
        const models = await listProviderModels({
            adapter: template.adapter,
            baseUrl: access.provider.base_url,
            apiKey: decryptApiKey(access.provider),
        });
        return c.json(success(Code.SUCCESS, { ok: true as const, models: models.sort() }));
    } catch (err) {
        return c.json(
            success(Code.SUCCESS, {
                ok: false as const,
                kind: classifyAiError(err).kind,
                message: getSafeAiErrorMessage(err),
            }),
        );
    }
});

// Model definitions offered for this provider, from the generated model catalog.
aiRouter.get("/providers/:id/catalog", requireAuth, validate("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = await loadOwnedProvider(c, id);
    if (access.denied) return access.denied;

    const template = getProviderTemplate(access.provider.template_id);
    if (!template) {
        return c.json(error(Code.INVALID_PARAMETER, `Unknown provider template '${access.provider.template_id}'`), 400);
    }
    return c.json(success(Code.SUCCESS, getProviderCatalog(template)));
});

const MatchCatalogBodySchema = v.object({
    ids: v.pipe(v.array(v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(256))), v.maxLength(2000)),
});

// Known definitions for model ids this provider serves: its own listing, then the model vendor's.
aiRouter.post(
    "/providers/:id/catalog/match",
    requireAuth,
    validate("param", IdParamSchema),
    validate("json", MatchCatalogBodySchema),
    async (c) => {
        const { id } = c.req.valid("param");
        const access = await loadOwnedProvider(c, id);
        if (access.denied) return access.denied;

        const template = getProviderTemplate(access.provider.template_id);
        if (!template) {
            return c.json(error(Code.INVALID_PARAMETER, `Unknown provider template '${access.provider.template_id}'`), 400);
        }
        return c.json(success(Code.SUCCESS, matchCatalogModels(template, c.req.valid("json").ids)));
    },
);

const ProbeModelBodySchema = v.object({
    name: v.pipe(v.string(), v.trim(), v.nonEmpty("Model name is required")),
    category: AiModelCategorySchema,
    capabilities: v.record(v.string(), v.unknown()),
});

// Verifies an unsaved model definition against the live provider with small real requests.
aiRouter.post("/providers/:id/probe", requireAuth, validate("param", IdParamSchema), validate("json", ProbeModelBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const access = await loadOwnedProvider(c, id);
    if (access.denied) return access.denied;

    const capabilities = parseModelCapabilities(body.category, body.capabilities);
    if (!capabilities) {
        return c.json(error(Code.INVALID_PARAMETER, `Invalid ${body.category} model capabilities`), 400);
    }
    const template = getProviderTemplate(access.provider.template_id);
    if (!template || !adapterSupportsModel(template.adapter, body.category, capabilities)) {
        return c.json(error(Code.INVALID_PARAMETER, "This provider cannot serve the selected model definition"), 400);
    }

    const checks = await probeModel({
        providerId: access.provider.id,
        limits: { maxConcurrency: access.provider.max_concurrency, requestsPerMinute: access.provider.requests_per_minute },
        providerName: access.provider.name,
        adapter: template.adapter,
        baseUrl: access.provider.base_url,
        apiKey: decryptApiKey(access.provider),
        modelName: body.name,
        category: body.category,
        capabilities,
    });
    return c.json(success(Code.SUCCESS, checks));
});

// Models of the current account.
aiRouter.get("/models", requireAuth, async (c) => {
    const access = requireAccountUser(c);
    if (access.denied) return access.denied;

    const rows = await db
        .select({ model: AiModel })
        .from(AiModel)
        .innerJoin(AiProvider, eq(AiModel.provider_id, AiProvider.id))
        .where(eq(AiProvider.owner_id, access.user.id))
        .orderBy(AiModel.create_time);
    const models = rows.map((row) => row.model).filter((model) => parseModelCapabilities(model.category, model.capabilities) !== null);

    return c.json(success(Code.SUCCESS, models));
});

const DisplayNameSchema = v.pipe(v.string(), v.trim(), v.nonEmpty("Display name is required"), v.maxLength(200));

const CreateModelBodySchema = v.object({
    provider_id: v.pipe(v.string(), v.uuid("Invalid provider ID")),
    name: v.pipe(v.string(), v.trim(), v.nonEmpty("Model name is required")),
    display_name: DisplayNameSchema,
    category: AiModelCategorySchema,
    capabilities: v.record(v.string(), v.unknown()),
});

aiRouter.post("/models", requireAuth, validate("json", CreateModelBodySchema), async (c) => {
    const body = c.req.valid("json");
    const access = await loadOwnedProvider(c, body.provider_id);
    if (access.denied) return access.denied;

    const capabilities = parseModelCapabilities(body.category, body.capabilities);
    if (!capabilities) {
        return c.json(error(Code.INVALID_PARAMETER, `Invalid ${body.category} model capabilities`), 400);
    }
    const template = getProviderTemplate(access.provider.template_id);
    if (!template || !adapterSupportsModel(template.adapter, body.category, capabilities)) {
        return c.json(error(Code.INVALID_PARAMETER, "This provider cannot serve the selected model definition"), 400);
    }

    const [model] = await db
        .insert(AiModel)
        .values({
            provider_id: body.provider_id,
            name: body.name,
            display_name: body.display_name,
            category: body.category,
            capabilities,
        })
        .onConflictDoNothing()
        .returning();
    if (!model) return c.json(error(Code.ALREADY_EXISTS, "This provider already has a model with that name"), 409);

    return c.json(success(Code.SUCCESS, model));
});

const UpdateModelBodySchema = v.object({
    display_name: DisplayNameSchema,
    capabilities: v.record(v.string(), v.unknown()),
});

/**
 * Edits a model's display name and definition in place. The model id, category and anything that defines its
 * embedding space (dimension, input template) are fixed: changing those means different vectors,
 * so it is a new model. Edits may not make the model unfit for a role it is bound to.
 */
aiRouter.put("/models/:id", requireAuth, validate("param", IdParamSchema), validate("json", UpdateModelBodySchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = requireAccountUser(c);
    if (access.denied) return access.denied;

    const rows = await db
        .select({ model: AiModel, provider: AiProvider })
        .from(AiModel)
        .innerJoin(AiProvider, eq(AiModel.provider_id, AiProvider.id))
        .where(and(eq(AiModel.id, id), eq(AiProvider.owner_id, access.user.id)))
        .limit(1);
    const row = rows[0];
    if (!row) return c.json(error(Code.NOT_FOUND, "Model not found"), 404);

    const category = row.model.category;
    const current = parseModelCapabilities(category, row.model.capabilities);
    const body = c.req.valid("json");
    const capabilities = parseModelCapabilities(category, body.capabilities);
    if (!capabilities) {
        return c.json(error(Code.INVALID_PARAMETER, `Invalid ${category} model capabilities`), 400);
    }
    const template = getProviderTemplate(row.provider.template_id);
    if (!template || !adapterSupportsModel(template.adapter, category, capabilities)) {
        return c.json(error(Code.INVALID_PARAMETER, "This provider cannot serve the edited model definition"), 400);
    }
    if (
        category === "embedding" &&
        (!current ||
            computeEmbeddingSpaceId(row.model.name, current as EmbeddingModelCapabilities) !==
                computeEmbeddingSpaceId(row.model.name, capabilities as EmbeddingModelCapabilities))
    ) {
        return c.json(error(Code.INVALID_PARAMETER, "This change produces different vectors; add it as a new model instead"), 400);
    }

    const boundRoles = await getRolesUsingModel(access.user.id, id);
    for (const role of boundRoles) {
        if (!supportsAiBindingRole(role, capabilities)) {
            return c.json(error(Code.INVALID_PARAMETER, `The model is used for ${role} and would no longer support it`), 400);
        }
    }

    const [model] = await db
        .update(AiModel)
        .set({ display_name: body.display_name, capabilities, update_time: sql`now()` })
        .where(eq(AiModel.id, id))
        .returning();
    return c.json(success(Code.SUCCESS, model));
});

aiRouter.delete("/models/:id", requireAuth, validate("param", IdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = requireAccountUser(c);
    if (access.denied) return access.denied;

    const rows = await db
        .select({ id: AiModel.id })
        .from(AiModel)
        .innerJoin(AiProvider, eq(AiModel.provider_id, AiProvider.id))
        .where(and(eq(AiModel.id, id), eq(AiProvider.owner_id, access.user.id)))
        .limit(1);
    if (!rows[0]) {
        return c.json(error(Code.NOT_FOUND, "Model not found"), 404);
    }

    await db.transaction(async (tx) => {
        await clearModelBindings(tx, access.user.id, [id]);
        await tx.delete(AiModel).where(eq(AiModel.id, id));
    });

    return c.json(success(Code.SUCCESS, null, "Model deleted successfully"));
});

// Role bindings of a library.
const LibraryParamSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid("Invalid library ID")),
});

aiRouter.get("/bindings/:library_id", requireAuth, validate("param", LibraryParamSchema), async (c) => {
    const { library_id } = c.req.valid("param");
    const access = await loadOwnedLibrary(c, library_id);
    if (access.denied) return access.denied;

    return c.json(success(Code.SUCCESS, { ...(await getLibraryBindings(library_id)), language: access.library.ai_language }));
});

aiRouter.post(
    "/bindings/:library_id",
    requireAuth,
    validate("param", LibraryParamSchema),
    validate("json", UpdateLibraryAiBindingsSchema),
    async (c) => {
        const { library_id } = c.req.valid("param");
        const access = await loadOwnedLibrary(c, library_id);
        if (access.denied) return access.denied;

        const data = c.req.valid("json");
        const current = await getLibraryBindings(library_id);
        const roleCategories: Array<[AiBindingRole, AiModelCategory]> = [
            ["describe", "generation"],
            ["textEmbedding", "embedding"],
            ["imageEmbedding", "embedding"],
            ["rerank", "rerank"],
        ];

        for (const [role, category] of roleCategories) {
            const binding = data[role];
            if (!binding) continue;
            try {
                const resolved = await resolveBindingConfig(binding, category, access.library.owner_id, role);
                if (!resolved) {
                    return c.json(error(Code.INVALID_PARAMETER, `${role} model was not found`), 400);
                }
                // Catalog flags only say what a model supports in principle: a newly bound model must work against the live provider.
                if (binding.modelId !== current[role]?.modelId) {
                    const failure = summarizeProbeFailures(await probeModel(resolved));
                    if (failure) {
                        return c.json(error(Code.INVALID_PARAMETER, `${role} model failed verification (${failure})`), 400);
                    }
                }
            } catch (err) {
                return c.json(error(Code.INVALID_PARAMETER, err instanceof Error ? err.message : `${role} model is invalid`), 400);
            }
        }

        const { indexingStarted } = await saveLibraryBindings(access.library, data);
        return c.json(
            success(
                Code.SUCCESS,
                { ...(await getLibraryBindings(library_id)), language: data.language ?? access.library.ai_language, indexingStarted },
                "AI bindings updated successfully",
            ),
        );
    },
);

// AI health of a library: embedding spaces, description progress, latest errors and unusable bindings.
aiRouter.get("/status/:library_id", requireAuth, validate("param", LibraryParamSchema), async (c) => {
    const { library_id } = c.req.valid("param");
    const access = await loadOwnedLibrary(c, library_id);
    if (access.denied) return access.denied;

    return c.json(success(Code.SUCCESS, await getLibraryAiStatus(library_id)));
});

aiRouter.post("/status/:library_id/retry-failed", requireAuth, validate("param", LibraryParamSchema), async (c) => {
    const { library_id } = c.req.valid("param");
    const access = await loadOwnedLibrary(c, library_id);
    if (access.denied) return access.denied;

    // Failed vectors go back to the queue; a space held back for low coverage also gets a fresh backfill.
    const requeued = await retryFailedEmbeddings(library_id);
    const backfills = await restartStalledBackfills(access.library);
    // Failed descriptions: re-process the library, which reuses stored results and retries only what is missing.
    const describeFailed = ((await getLibraryDescribeStatus(library_id))?.failed ?? 0) > 0;
    if (describeFailed && backfills === 0) await queueLibraryAiEnrichment(library_id, access.library.owner_id, { redescribe: false });
    return c.json(success(Code.SUCCESS, { requeued, backfills, describeRequeued: describeFailed }));
});

// Replaces the descriptions that other models wrote with the library's current describe model.
aiRouter.post("/status/:library_id/redescribe", requireAuth, validate("param", LibraryParamSchema), async (c) => {
    const { library_id } = c.req.valid("param");
    const access = await loadOwnedLibrary(c, library_id);
    if (access.denied) return access.denied;

    if (!(await getLibraryDescribeStatus(library_id))) {
        return c.json(error(Code.INVALID_PARAMETER, "No usable describe model is bound to this library"), 400);
    }
    await queueLibraryAiEnrichment(library_id, access.library.owner_id, { redescribe: true });
    return c.json(success(Code.SUCCESS, null, "Re-describing started"));
});
