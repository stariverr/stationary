import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
    AiModel,
    AssetEmbedding,
    DeleteStatus,
    EmbeddingRole,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
} from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect, PIPELINE_NAMES, queueName, scanQueueName, spaceRoleOf, type PipelineName } from "@/infra/queue/pipelines";
import { countRows, deleteQueues } from "@/infra/queue/store";
import { parseModelCapabilities, type EmbeddingModelCapabilities } from "./model-schema";
import type { AiErrorView, EmbeddingBindingRole } from "./types";
import { computeEmbeddingSpaceId } from "./utils";

/**
 * A library searches one ACTIVE space per embedding role. Choosing a model that writes another
 * space creates a BUILDING space: the role's pipeline fills both, and once the BUILDING space's
 * queue has drained and it covers the library, it replaces the ACTIVE one. Search keeps working
 * throughout. The replaced space stays RETIRED for a while, so choosing its model again restores
 * it without re-embedding everything.
 */

export const EMBEDDING_ROLES: EmbeddingBindingRole[] = ["textEmbedding", "imageEmbedding"];

/** Embedding role written for each binding role. */
export const EMBEDDING_ROLE_FOR: Record<EmbeddingBindingRole, EmbeddingRole> = {
    textEmbedding: EmbeddingRole.AI_CAPTION,
    imageEmbedding: EmbeddingRole.IMAGE_PRIMARY,
};

/** A BUILDING space must hold at least this share of the vectors the ACTIVE space holds. */
export const MIN_SPACE_COVERAGE = 0.95;
/** A BUILDING space is held back while more than this share of its finished vectors failed. */
export const MAX_SPACE_FAILED_SHARE = 0.05;
/** How long a RETIRED space is kept for switching back. */
export const RETIRED_SPACE_RETENTION_DAYS = 7;

/** Why a BUILDING space whose queue has drained still does not replace the ACTIVE one. */
export type SpaceBlockReason = "low_coverage" | "too_many_failures";

export interface BuildProgress {
    /** Rows of the space's queue, its library scan included. */
    pending: number;
    /** Media with a vector in the space. */
    ready: number;
    /** Media without a vector whose last attempt failed. */
    failed: number;
    /** Media with a vector in the ACTIVE space of the same role. */
    activeReady: number;
}

export type BuildAssessment = { state: "waiting" } | { state: "ready" } | { state: "blocked"; reason: SpaceBlockReason };

/**
 * Whether a BUILDING space may replace the ACTIVE one. A drained queue alone is not enough: a broken
 * model (wrong key, unsupported input) drains its queue by failing every row. Promotion needs few
 * failures and coverage comparable to the ACTIVE space.
 */
export function assessBuildingSpace(progress: BuildProgress): BuildAssessment {
    if (progress.pending > 0) return { state: "waiting" };
    if (progress.failed > (progress.ready + progress.failed) * MAX_SPACE_FAILED_SHARE) {
        return { state: "blocked", reason: "too_many_failures" };
    }
    if (progress.ready < progress.activeReady * MIN_SPACE_COVERAGE) return { state: "blocked", reason: "low_coverage" };
    return { state: "ready" };
}

type SpaceRow = typeof LibraryEmbeddingSpace.$inferSelect;

/** The per-space pipeline that writes spaces of `role`. */
export function pipelineOfRole(role: EmbeddingBindingRole): PipelineName {
    return PIPELINE_NAMES.find((pipeline) => spaceRoleOf(pipeline) === role)!;
}

/** The queues of one space: its subject rows and its library scan. */
export function spaceQueues(space: Pick<SpaceRow, "id" | "role">): string[] {
    const pipeline = pipelineOfRole(space.role);
    return [queueName(pipeline, space.id), scanQueueName(pipeline, space.id)];
}

async function modelSpaceId(tx: Transaction, modelId: string): Promise<string> {
    const model = (await tx.select().from(AiModel).where(eq(AiModel.id, modelId)).limit(1))[0];
    const capabilities = model ? parseModelCapabilities("embedding", model.capabilities) : null;
    if (!model || !capabilities) throw new Error(`Embedding model ${modelId} is missing or invalid`);
    return computeEmbeddingSpaceId(model.name, capabilities as EmbeddingModelCapabilities);
}

/** Vectors (and recorded failures) a library holds in one space. */
const ofSpace = (space: Pick<SpaceRow, "library_id" | "space_id" | "role">) =>
    and(
        eq(AssetEmbedding.library_id, space.library_id),
        eq(AssetEmbedding.embedding_space_id, space.space_id),
        eq(AssetEmbedding.embedding_role, EMBEDDING_ROLE_FOR[space.role]),
    );

/** Removes a library space, the vectors it holds and its queued work. */
async function dropSpace(tx: DbClient, space: SpaceRow) {
    await tx.delete(AssetEmbedding).where(ofSpace(space));
    await deleteQueues(tx, spaceQueues(space));
    await tx.delete(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.id, space.id));
}

/**
 * Aligns a library's spaces for `role` with the chosen model (null removes the role) inside the
 * caller's transaction. A space that starts being written is reported as a change of the library's
 * spaces, which queues a scan that fills it.
 */
export async function alignEmbeddingSpace(
    tx: Transaction,
    library: { id: string },
    role: EmbeddingBindingRole,
    modelId: string | null,
): Promise<void> {
    const spaceId = modelId ? await modelSpaceId(tx, modelId) : null;
    const spaces = await tx
        .select()
        .from(LibraryEmbeddingSpace)
        .where(and(eq(LibraryEmbeddingSpace.library_id, library.id), eq(LibraryEmbeddingSpace.role, role)))
        .for("update");
    const active = spaces.find((space) => space.status === LibraryEmbeddingSpaceStatus.ACTIVE);
    const building = spaces.find((space) => space.status === LibraryEmbeddingSpaceStatus.BUILDING);
    const retired = spaces.find((space) => space.status === LibraryEmbeddingSpaceStatus.RETIRED);

    if (!modelId || !spaceId) {
        for (const space of spaces) await dropSpace(tx, space);
        return;
    }

    const keep = async (space: SpaceRow) =>
        tx
            .update(LibraryEmbeddingSpace)
            .set({ model_id: modelId, update_time: sql`now()` })
            .where(eq(LibraryEmbeddingSpace.id, space.id));

    if (active?.space_id === spaceId) {
        // Same vectors (possibly served by another provider): keep the space, drop any rebuild.
        if (building) await dropSpace(tx, building);
        await keep(active);
        return;
    }
    if (building?.space_id === spaceId) {
        await keep(building);
        return;
    }

    if (building) await dropSpace(tx, building);
    // Without an active space nothing else can serve, so the new space serves right away.
    const status = active ? LibraryEmbeddingSpaceStatus.BUILDING : LibraryEmbeddingSpaceStatus.ACTIVE;
    if (retired?.space_id === spaceId) {
        // Switching back: the retired vectors are reused and the scan only fills what changed since.
        await tx
            .update(LibraryEmbeddingSpace)
            .set({ model_id: modelId, status, update_time: sql`now()` })
            .where(eq(LibraryEmbeddingSpace.id, retired.id));
    } else {
        await tx.insert(LibraryEmbeddingSpace).values({ library_id: library.id, role, model_id: modelId, space_id: spaceId, status });
    }
    await markChanged(tx, Aspect.LIBRARY_SPACES, [library.id]);
}

/** Drops every library space served by one of `modelIds`; used when models or providers are deleted. */
export async function dropSpacesOfModels(tx: Transaction, modelIds: string[]): Promise<void> {
    if (modelIds.length === 0) return;
    const spaces = await tx.select().from(LibraryEmbeddingSpace).where(inArray(LibraryEmbeddingSpace.model_id, modelIds)).for("update");
    for (const space of spaces) await dropSpace(tx, space);
}

const ofActiveMedia = sql`exists (
    select 1 from ${Media}
    where ${Media.id} = ${AssetEmbedding.entity_id}
      and ${Media.delete_status} = ${DeleteStatus.ACTIVE}
      and ${Media.recycle_time} is null
)`;

/** Media of a library space with a vector, and without one after a failure. Recycled media are left out. */
async function countVectors(space: Pick<SpaceRow, "library_id" | "space_id" | "role">) {
    const [counts] = await db
        .select({
            ready: sql<number>`(count(*) filter (where ${AssetEmbedding.embedding} is not null))::int`,
            failed: sql<number>`(count(*) filter (where ${AssetEmbedding.embedding} is null and ${AssetEmbedding.last_error} is not null))::int`,
        })
        .from(AssetEmbedding)
        .where(and(ofSpace(space), ofActiveMedia));
    return counts!;
}

/** Progress of a BUILDING space against the ACTIVE space of its role. */
async function buildProgress(space: SpaceRow): Promise<BuildProgress> {
    const [active] = await db
        .select()
        .from(LibraryEmbeddingSpace)
        .where(
            and(
                eq(LibraryEmbeddingSpace.library_id, space.library_id),
                eq(LibraryEmbeddingSpace.role, space.role),
                eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.ACTIVE),
            ),
        )
        .limit(1);
    const [counts, pending, activeReady] = await Promise.all([
        countVectors(space),
        countRows(space.library_id, spaceQueues(space)),
        active ? countVectors(active).then((activeCounts) => activeCounts.ready) : 0,
    ]);
    return { pending, ...counts, activeReady };
}

/**
 * Promotes a BUILDING space that covers its library (see assessBuildingSpace). The ACTIVE space it
 * replaces becomes RETIRED, replacing any older RETIRED space of the role. Returns whether it did.
 */
export async function promoteIfBuilt(spaceRowId: string): Promise<boolean> {
    const [space] = await db.select().from(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.id, spaceRowId)).limit(1);
    if (space?.status !== LibraryEmbeddingSpaceStatus.BUILDING) return false;
    if (assessBuildingSpace(await buildProgress(space)).state !== "ready") return false;

    const done = await db.transaction(async (tx) => {
        const current = await tx
            .select()
            .from(LibraryEmbeddingSpace)
            .where(and(eq(LibraryEmbeddingSpace.library_id, space.library_id), eq(LibraryEmbeddingSpace.role, space.role)))
            .for("update");
        if (!current.some((row) => row.id === space.id && row.status === LibraryEmbeddingSpaceStatus.BUILDING)) return false;

        // One status per role at a time: clear RETIRED before ACTIVE moves there.
        for (const row of current) {
            if (row.status === LibraryEmbeddingSpaceStatus.RETIRED) await dropSpace(tx, row);
        }
        for (const row of current) {
            if (row.status !== LibraryEmbeddingSpaceStatus.ACTIVE) continue;
            await tx
                .update(LibraryEmbeddingSpace)
                .set({ status: LibraryEmbeddingSpaceStatus.RETIRED, update_time: sql`now()` })
                .where(eq(LibraryEmbeddingSpace.id, row.id));
            // A RETIRED space is not written.
            await deleteQueues(tx, spaceQueues(row));
        }
        await tx
            .update(LibraryEmbeddingSpace)
            .set({ status: LibraryEmbeddingSpaceStatus.ACTIVE, update_time: sql`now()` })
            .where(eq(LibraryEmbeddingSpace.id, space.id));
        return true;
    });
    if (done) console.log(`[AI SPACES] Library ${space.library_id} now searches ${space.role} space ${space.space_id}.`);
    return done;
}

/** Promotes every BUILDING space of `role` that is ready; a periodic catch-all next to the check after each run. */
export async function promoteBuiltSpaces(role: EmbeddingBindingRole): Promise<void> {
    const building = await db
        .select({ id: LibraryEmbeddingSpace.id })
        .from(LibraryEmbeddingSpace)
        .where(and(eq(LibraryEmbeddingSpace.role, role), eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.BUILDING)));
    for (const space of building) await promoteIfBuilt(space.id);
}

/** Drops RETIRED spaces of `role` older than the retention period. */
export async function dropExpiredRetiredSpaces(role: EmbeddingBindingRole): Promise<void> {
    await db.transaction(async (tx) => {
        const expired = await tx
            .select()
            .from(LibraryEmbeddingSpace)
            .where(
                and(
                    eq(LibraryEmbeddingSpace.role, role),
                    eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.RETIRED),
                    lt(LibraryEmbeddingSpace.update_time, sql`now() - (${RETIRED_SPACE_RETENTION_DAYS} * interval '1 day')`),
                ),
            )
            .for("update", { skipLocked: true });
        for (const space of expired) await dropSpace(tx, space);
    });
}

/** The latest error recorded in a library space; null once every vector of the space is stored. */
async function latestEmbeddingError(space: SpaceRow): Promise<AiErrorView | null> {
    const [row] = await db
        .select({ message: AssetEmbedding.last_error, at: AssetEmbedding.update_time })
        .from(AssetEmbedding)
        .where(and(ofSpace(space), isNotNull(AssetEmbedding.last_error), ofActiveMedia))
        .orderBy(desc(AssetEmbedding.update_time))
        .limit(1);
    return row?.message && row.at ? { message: row.message, at: row.at.toString() } : null;
}

export interface EmbeddingSpaceStatusView {
    role: EmbeddingBindingRole;
    status: LibraryEmbeddingSpaceStatus;
    modelId: string;
    spaceId: string;
    /** Media the space has a vector, a failure or queued work for; a rebuild counts at least what the ACTIVE space holds. */
    total: number;
    /** Media with a vector in the space. */
    ready: number;
    /** Media queued for the space; zero for RETIRED spaces, which are not written. */
    pending: number;
    /** Media without a vector whose last attempt failed. */
    failed: number;
    /** BUILDING only: why the drained space does not replace the ACTIVE one yet. */
    blocked: SpaceBlockReason | null;
    /** RETIRED only: when the space is dropped. */
    retainedUntil: string | null;
    /** Latest error recorded in the space; null for RETIRED spaces. */
    lastError: AiErrorView | null;
}

/** Progress of every embedding space of a library. */
export async function getLibraryEmbeddingStatus(libraryId: string) {
    const spaces = await db.select().from(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.library_id, libraryId));

    const views: EmbeddingSpaceStatusView[] = [];
    for (const role of EMBEDDING_ROLES) {
        for (const space of spaces.filter((row) => row.role === role)) {
            const retired = space.status === LibraryEmbeddingSpaceStatus.RETIRED;
            const [counts, pending, lastError] = await Promise.all([
                countVectors(space),
                retired ? 0 : countRows(libraryId, [spaceQueues(space)[0]!]),
                retired ? null : latestEmbeddingError(space),
            ]);
            let total = counts.ready + counts.failed + pending;
            let blocked: SpaceBlockReason | null = null;
            if (space.status === LibraryEmbeddingSpaceStatus.BUILDING) {
                const progress = await buildProgress(space);
                const assessment = assessBuildingSpace(progress);
                total = Math.max(total, progress.activeReady);
                blocked = assessment.state === "blocked" ? assessment.reason : null;
            }
            views.push({
                role,
                status: space.status,
                modelId: space.model_id,
                spaceId: space.space_id,
                total,
                ready: counts.ready,
                pending,
                failed: counts.failed,
                blocked,
                retainedUntil: retired
                    ? (space.update_time ?? space.create_time).add({ hours: RETIRED_SPACE_RETENTION_DAYS * 24 }).toString()
                    : null,
                lastError,
            });
        }
    }
    return { spaces: views };
}
