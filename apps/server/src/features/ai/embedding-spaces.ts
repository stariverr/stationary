import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
    AiModel,
    AssetEmbedding,
    AsyncTask,
    AsyncTaskStatus,
    DeleteStatus,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { queueLibraryAiEnrichment } from "./queue-enrichment";
import { countEmbeddings, EMBEDDING_ROLE_FOR } from "./embedding-queue";
import { parseModelCapabilities, type EmbeddingModelCapabilities } from "./model-schema";
import type { EmbeddingBindingRole } from "./types";
import { computeEmbeddingSpaceId } from "./utils";

/**
 * A library searches one ACTIVE space per embedding role. Choosing a model that writes another
 * space creates a BUILDING space: enrichment fills both, and once the BUILDING space covers the
 * library it replaces the ACTIVE one. Search keeps working throughout. The replaced space stays
 * RETIRED for a while, so choosing its model again restores it without re-embedding everything.
 */

const EMBEDDING_ROLES: EmbeddingBindingRole[] = ["textEmbedding", "imageEmbedding"];

/** A BUILDING space must hold at least this share of the vectors the ACTIVE space holds. */
export const MIN_SPACE_COVERAGE = 0.95;
/** A BUILDING space is held back while more than this share of its finished vectors failed. */
export const MAX_SPACE_FAILED_SHARE = 0.05;
/** How long a RETIRED space is kept for switching back. */
export const RETIRED_SPACE_RETENTION_DAYS = 7;

const TERMINAL_TASK_STATUSES = [AsyncTaskStatus.COMPLETED, AsyncTaskStatus.FAILED, AsyncTaskStatus.CANCELLED];

/** Why a BUILDING space whose work has drained still does not replace the ACTIVE one. */
export type SpaceBlockReason = "low_coverage" | "too_many_failures";

export interface BuildProgress {
    /** The backfill task is still discovering, running or paused. */
    backfillRunning: boolean;
    ready: number;
    pending: number;
    failed: number;
    /** READY vectors of the ACTIVE space of the same role. */
    activeReady: number;
}

export type BuildAssessment = { state: "waiting" } | { state: "ready" } | { state: "blocked"; reason: SpaceBlockReason };

/**
 * Whether a BUILDING space may replace the ACTIVE one. Finished work alone is not enough: a broken
 * model (wrong key, unsupported input) drains its queue by failing every row, and a cancelled
 * backfill drains early. Promotion needs few failures and coverage comparable to the ACTIVE space.
 */
export function assessBuildingSpace(progress: BuildProgress): BuildAssessment {
    if (progress.backfillRunning || progress.pending > 0) return { state: "waiting" };
    if (progress.failed > (progress.ready + progress.failed) * MAX_SPACE_FAILED_SHARE) {
        return { state: "blocked", reason: "too_many_failures" };
    }
    if (progress.ready < progress.activeReady * MIN_SPACE_COVERAGE) return { state: "blocked", reason: "low_coverage" };
    return { state: "ready" };
}

type SpaceRow = typeof LibraryEmbeddingSpace.$inferSelect;

async function modelSpaceId(modelId: string): Promise<string> {
    const model = (await db.select().from(AiModel).where(eq(AiModel.id, modelId)).limit(1))[0];
    const capabilities = model ? parseModelCapabilities("embedding", model.capabilities) : null;
    if (!model || !capabilities) throw new Error(`Embedding model ${modelId} is missing or invalid`);
    return computeEmbeddingSpaceId(model.name, capabilities as EmbeddingModelCapabilities);
}

/** Removes a library space and the vectors it holds for that role. */
async function dropSpace(tx: Transaction, space: SpaceRow) {
    await tx
        .delete(AssetEmbedding)
        .where(
            and(
                eq(AssetEmbedding.library_id, space.library_id),
                eq(AssetEmbedding.embedding_space_id, space.space_id),
                eq(AssetEmbedding.embedding_role, EMBEDDING_ROLE_FOR[space.role]),
            ),
        );
    await tx.delete(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.id, space.id));
}

/** Starts a library-wide enrichment that fills `space`, and records it as the space's backfill. */
async function startBackfill(library: { id: string; owner_id: string }, spaceRowId: string) {
    const taskId = await queueLibraryAiEnrichment(library.id, library.owner_id);
    await db.update(LibraryEmbeddingSpace).set({ backfill_task_id: taskId }).where(eq(LibraryEmbeddingSpace.id, spaceRowId));
}

/**
 * Aligns a library's spaces for `role` with the chosen model (null removes the role).
 * Called whenever the role binding is saved.
 */
export async function syncEmbeddingSpace(
    library: { id: string; owner_id: string },
    role: EmbeddingBindingRole,
    modelId: string | null,
): Promise<void> {
    const spaceId = modelId ? await modelSpaceId(modelId) : null;
    const backfillSpaceRowId = await db.transaction(async (tx): Promise<string | null> => {
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
            return null;
        }

        if (active?.space_id === spaceId) {
            // Same vectors (possibly served by another provider): keep the space, drop any rebuild.
            if (building) await dropSpace(tx, building);
            await tx
                .update(LibraryEmbeddingSpace)
                .set({ model_id: modelId, update_time: sql`now()` })
                .where(eq(LibraryEmbeddingSpace.id, active.id));
            return null;
        }

        if (building?.space_id === spaceId) {
            await tx
                .update(LibraryEmbeddingSpace)
                .set({ model_id: modelId, update_time: sql`now()` })
                .where(eq(LibraryEmbeddingSpace.id, building.id));
            return null;
        }

        if (building) await dropSpace(tx, building);
        // Without an active space nothing else can serve, so the new space serves right away.
        const status = active ? LibraryEmbeddingSpaceStatus.BUILDING : LibraryEmbeddingSpaceStatus.ACTIVE;

        if (retired?.space_id === spaceId) {
            // Switching back: the retired vectors are reused and the backfill only fills what changed since.
            await tx
                .update(LibraryEmbeddingSpace)
                .set({ model_id: modelId, status, backfill_task_id: null, update_time: sql`now()` })
                .where(eq(LibraryEmbeddingSpace.id, retired.id));
            return retired.id;
        }

        const [inserted] = await tx
            .insert(LibraryEmbeddingSpace)
            .values({ library_id: library.id, role, model_id: modelId, space_id: spaceId, status })
            .returning({ id: LibraryEmbeddingSpace.id });
        return inserted!.id;
    });

    if (backfillSpaceRowId) await startBackfill(library, backfillSpaceRowId);
}

/** Drops every library space served by one of `modelIds`; used when models or providers are deleted. */
export async function dropSpacesOfModels(modelIds: string[]): Promise<void> {
    if (modelIds.length === 0) return;
    await db.transaction(async (tx) => {
        const spaces = await tx.select().from(LibraryEmbeddingSpace).where(inArray(LibraryEmbeddingSpace.model_id, modelIds)).for("update");
        for (const space of spaces) await dropSpace(tx, space);
    });
}

/** Progress of a BUILDING space against the ACTIVE space of its role. */
async function buildProgress(space: SpaceRow, backfillStatus: AsyncTaskStatus | null): Promise<BuildProgress> {
    const role = EMBEDDING_ROLE_FOR[space.role];
    const active = (
        await db
            .select({ space_id: LibraryEmbeddingSpace.space_id })
            .from(LibraryEmbeddingSpace)
            .where(
                and(
                    eq(LibraryEmbeddingSpace.library_id, space.library_id),
                    eq(LibraryEmbeddingSpace.role, space.role),
                    eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.ACTIVE),
                ),
            )
            .limit(1)
    )[0];
    const counts = await countEmbeddings(space.library_id, space.space_id, role);
    const activeReady = active ? (await countEmbeddings(space.library_id, active.space_id, role)).ready : 0;
    return {
        backfillRunning: backfillStatus !== null && !TERMINAL_TASK_STATUSES.includes(backfillStatus),
        ...counts,
        activeReady,
    };
}

/** BUILDING spaces with the status of their backfill task (null when it no longer exists). */
async function buildingSpaces(libraryId?: string) {
    return db
        .select({ space: LibraryEmbeddingSpace, backfillStatus: AsyncTask.status })
        .from(LibraryEmbeddingSpace)
        .leftJoin(AsyncTask, eq(LibraryEmbeddingSpace.backfill_task_id, AsyncTask.id))
        .where(
            and(
                eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.BUILDING),
                ...(libraryId ? [eq(LibraryEmbeddingSpace.library_id, libraryId)] : []),
            ),
        );
}

/**
 * Promotes BUILDING spaces that cover their library (see assessBuildingSpace). The ACTIVE space
 * they replace becomes RETIRED, replacing any older RETIRED space of the role.
 */
export async function promoteBuiltSpaces(): Promise<number> {
    let promoted = 0;
    for (const { space, backfillStatus } of await buildingSpaces()) {
        if (assessBuildingSpace(await buildProgress(space, backfillStatus)).state !== "ready") continue;

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
                    .set({ status: LibraryEmbeddingSpaceStatus.RETIRED, backfill_task_id: null, update_time: sql`now()` })
                    .where(eq(LibraryEmbeddingSpace.id, row.id));
            }
            await tx
                .update(LibraryEmbeddingSpace)
                .set({ status: LibraryEmbeddingSpaceStatus.ACTIVE, update_time: sql`now()` })
                .where(eq(LibraryEmbeddingSpace.id, space.id));
            return true;
        });
        if (done) {
            promoted += 1;
            console.log(`[AI SPACES] Library ${space.library_id} now searches ${space.role} space ${space.space_id}.`);
        }
    }
    return promoted;
}

/** Drops RETIRED spaces older than the retention period. Returns how many were dropped. */
export async function dropExpiredRetiredSpaces(): Promise<number> {
    return db.transaction(async (tx) => {
        const expired = await tx
            .select()
            .from(LibraryEmbeddingSpace)
            .where(
                and(
                    eq(LibraryEmbeddingSpace.status, LibraryEmbeddingSpaceStatus.RETIRED),
                    lt(LibraryEmbeddingSpace.update_time, sql`now() - (${RETIRED_SPACE_RETENTION_DAYS} * interval '1 day')`),
                ),
            )
            .for("update", { skipLocked: true });
        for (const space of expired) await dropSpace(tx, space);
        return expired.length;
    });
}

/**
 * Restarts the backfill of BUILDING spaces held back for low coverage, e.g. after the previous
 * backfill was cancelled. Enrichment reuses stored results, so only missing work reaches a provider.
 * Returns how many backfills were started.
 */
export async function restartStalledBackfills(library: { id: string; owner_id: string }): Promise<number> {
    let restarted = 0;
    for (const { space, backfillStatus } of await buildingSpaces(library.id)) {
        const assessment = assessBuildingSpace(await buildProgress(space, backfillStatus));
        if (assessment.state !== "blocked" || assessment.reason !== "low_coverage") continue;
        await startBackfill(library, space.id);
        restarted += 1;
    }
    return restarted;
}

export interface EmbeddingSpaceStatusView {
    role: EmbeddingBindingRole;
    status: LibraryEmbeddingSpaceStatus;
    modelId: string;
    spaceId: string;
    ready: number;
    pending: number;
    failed: number;
    /** BUILDING only: why the drained space does not replace the ACTIVE one yet. */
    blocked: SpaceBlockReason | null;
    /** RETIRED only: when the space is dropped. */
    retainedUntil: string | null;
}

/** Progress of every embedding space of a library, plus how many media it should cover. */
export async function getLibraryEmbeddingStatus(libraryId: string) {
    const spaces = await db.select().from(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.library_id, libraryId));
    const building = new Map((await buildingSpaces(libraryId)).map((row) => [row.space.id, row.backfillStatus]));
    const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(Media)
        .where(and(eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

    const views: EmbeddingSpaceStatusView[] = [];
    for (const role of EMBEDDING_ROLES) {
        for (const space of spaces.filter((row) => row.role === role)) {
            let counts: { ready: number; pending: number; failed: number };
            let blocked: SpaceBlockReason | null = null;
            if (space.status === LibraryEmbeddingSpaceStatus.BUILDING) {
                const progress = await buildProgress(space, building.get(space.id) ?? null);
                const assessment = assessBuildingSpace(progress);
                counts = progress;
                blocked = assessment.state === "blocked" ? assessment.reason : null;
            } else {
                counts = await countEmbeddings(libraryId, space.space_id, EMBEDDING_ROLE_FOR[role]);
            }
            views.push({
                role,
                status: space.status,
                modelId: space.model_id,
                spaceId: space.space_id,
                ready: counts.ready,
                pending: counts.pending,
                failed: counts.failed,
                blocked,
                retainedUntil:
                    space.status === LibraryEmbeddingSpaceStatus.RETIRED
                        ? (space.update_time ?? space.create_time).add({ hours: RETIRED_SPACE_RETENTION_DAYS * 24 }).toString()
                        : null,
            });
        }
    }
    return { mediaTotal: total, spaces: views };
}
