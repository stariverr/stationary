import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Library, LibraryEmbeddingSpace, LibraryEmbeddingSpaceStatus } from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { alignEmbeddingSpace, dropSpacesOfModels, startBackfill } from "./embedding-spaces";
import { AI_BINDING_ROLES, type AiBindingRole, type LibraryAiBindings, type RoleBinding } from "./model-schema";
import { queueLibraryAiEnrichment } from "./queue-enrichment";
import type { EmbeddingBindingRole } from "./types";

/**
 * Which model serves each role of a library. Every role has exactly one home:
 * - describe and rerank are stored on the library (`ai_bindings`);
 * - the embedding roles are stored as the library's embedding spaces, because the space is what
 *   serves, so a second copy on the library could only drift from it.
 */
const LIBRARY_ROLES = ["describe", "rerank"] as const;
const EMBEDDING_ROLES: EmbeddingBindingRole[] = ["textEmbedding", "imageEmbedding"];

type LibraryRoleBindings = Partial<Record<(typeof LIBRARY_ROLES)[number], RoleBinding | null>>;

/** The model each role is set to. While a rebuild runs, an embedding role shows the model being built. */
export async function getLibraryBindings(libraryId: string): Promise<LibraryAiBindings> {
    const [[library], spaces] = await Promise.all([
        db.select({ ai_bindings: Library.ai_bindings }).from(Library).where(eq(Library.id, libraryId)).limit(1),
        db
            .select({ role: LibraryEmbeddingSpace.role, status: LibraryEmbeddingSpace.status, model_id: LibraryEmbeddingSpace.model_id })
            .from(LibraryEmbeddingSpace)
            .where(
                and(
                    eq(LibraryEmbeddingSpace.library_id, libraryId),
                    inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
                ),
            ),
    ]);
    const bindings: LibraryAiBindings = {
        describe: library?.ai_bindings?.describe ?? null,
        rerank: library?.ai_bindings?.rerank ?? null,
    };
    for (const role of EMBEDDING_ROLES) {
        const served = spaces.filter((space) => space.role === role);
        const chosen = served.find((space) => space.status === LibraryEmbeddingSpaceStatus.BUILDING) ?? served[0];
        bindings[role] = chosen ? { modelId: chosen.model_id } : null;
    }
    return bindings;
}

/** Roles of the owner's libraries that currently use `modelId`. */
export async function getRolesUsingModel(ownerId: string, modelId: string): Promise<AiBindingRole[]> {
    const [libraries, spaces] = await Promise.all([
        db
            .select({ ai_bindings: Library.ai_bindings })
            .from(Library)
            .where(and(eq(Library.owner_id, ownerId), isNotNull(Library.ai_bindings))),
        db
            .select({ role: LibraryEmbeddingSpace.role })
            .from(LibraryEmbeddingSpace)
            .innerJoin(Library, eq(LibraryEmbeddingSpace.library_id, Library.id))
            .where(
                and(
                    eq(Library.owner_id, ownerId),
                    eq(LibraryEmbeddingSpace.model_id, modelId),
                    // A RETIRED space serves nothing: it only keeps vectors for switching back.
                    inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
                ),
            ),
    ]);
    const roles = new Set<AiBindingRole>(spaces.map((space) => space.role));
    for (const library of libraries) {
        for (const role of LIBRARY_ROLES) {
            if (library.ai_bindings?.[role]?.modelId === modelId) roles.add(role);
        }
    }
    return AI_BINDING_ROLES.filter((role) => roles.has(role));
}

/**
 * Applies the requested role changes and language to a library in one transaction, so a failure
 * leaves nothing half-applied. Work that needs the committed state (backfills, re-describing
 * after a language change) is queued afterwards.
 */
export async function saveLibraryBindings(
    library: { id: string; owner_id: string },
    changes: LibraryAiBindings,
    language?: string,
): Promise<{ indexingStarted: boolean }> {
    const { backfills, languageChanged, describeModelId } = await db.transaction(async (tx) => {
        const [current] = await tx
            .select({ ai_bindings: Library.ai_bindings, ai_language: Library.ai_language })
            .from(Library)
            .where(eq(Library.id, library.id))
            .for("update");
        if (!current) throw new Error(`Library ${library.id} not found`);

        const next: LibraryRoleBindings = { ...current.ai_bindings };
        for (const role of LIBRARY_ROLES) {
            if (changes[role] !== undefined) next[role] = changes[role];
        }
        const languageChanged = language !== undefined && language !== current.ai_language;
        await tx
            .update(Library)
            .set({ ai_bindings: next, ...(languageChanged ? { ai_language: language } : {}) })
            .where(eq(Library.id, library.id));

        const backfills: string[] = [];
        for (const role of EMBEDDING_ROLES) {
            if (changes[role] === undefined) continue;
            const spaceRowId = await alignEmbeddingSpace(tx, library, role, changes[role]?.modelId ?? null);
            if (spaceRowId) backfills.push(spaceRowId);
        }
        return { backfills, languageChanged, describeModelId: next.describe?.modelId };
    });

    // The bindings are saved either way. If queuing fails, saving the same bindings again retries
    // it: a space without a backfill task is returned by alignEmbeddingSpace.
    try {
        // A backfill is already a full library enrichment, so it also re-describes after a language
        // change. Descriptions in the old language are stale: re-describe the library (search
        // documents and text vectors follow automatically).
        if (backfills.length > 0) await startBackfill(library, backfills);
        else if (languageChanged && describeModelId) await queueLibraryAiEnrichment(library.id, library.owner_id);
        return { indexingStarted: true };
    } catch (error) {
        console.error(`[AI BINDINGS] Saved bindings of library ${library.id} but could not start indexing:`, error);
        return { indexingStarted: false };
    }
}

/** Clears the roles and drops the spaces of the owner's libraries that use any of `modelIds`. */
export async function clearModelBindings(tx: Transaction, ownerId: string, modelIds: string[]): Promise<void> {
    if (modelIds.length === 0) return;
    await dropSpacesOfModels(tx, modelIds);
    const libraries = await tx
        .select({ id: Library.id, ai_bindings: Library.ai_bindings })
        .from(Library)
        .where(and(eq(Library.owner_id, ownerId), isNotNull(Library.ai_bindings)))
        .for("update");

    for (const library of libraries) {
        const bindings: LibraryRoleBindings = { ...library.ai_bindings };
        let changed = false;
        for (const role of LIBRARY_ROLES) {
            const binding = bindings[role];
            if (binding && modelIds.includes(binding.modelId)) {
                bindings[role] = null;
                changed = true;
            }
        }
        if (changed) await tx.update(Library).set({ ai_bindings: bindings }).where(eq(Library.id, library.id));
    }
}
