import { and, asc, desc, eq, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import {
    AssetEmbedding,
    DeleteStatus,
    EmbeddingRole,
    EmbeddingStatus,
    EntityType,
    File as DbFile,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
    ModalityType,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { kv } from "@/global/kv";
import { retryDelaySeconds } from "@/infra/jobs/policy";
import { AiProviderError, AiThrottledError, classifyAiError, getSafeAiErrorMessage } from "./errors";
import { readAiSourceImage } from "./image-source";
import { AiService } from "./service";
import type { AiErrorView, EmbeddingBindingRole, EmbeddingResult, TextEmbeddingProvider, VisualEmbeddingProvider } from "./types";

/**
 * Embedding work is queued as PENDING `asset_embedding` rows: the row is the request and, once
 * filled, the result. A worker drains the queue in batches of one library, space and modality,
 * so several media share one provider request.
 */

export const EMBEDDING_QUEUE_CHANNEL = "ai:embedding:wake";
const CLAIM_LEASE_SECONDS = 300;
export const MAX_EMBEDDING_ATTEMPTS = 5;

/** Embedding role written for each binding role. */
export const EMBEDDING_ROLE_FOR: Record<EmbeddingBindingRole, EmbeddingRole> = {
    textEmbedding: EmbeddingRole.AI_CAPTION,
    imageEmbedding: EmbeddingRole.IMAGE_PRIMARY,
};

export interface EmbeddingRequest {
    libraryId: string;
    mediaId: string;
    role: EmbeddingRole;
    modality: ModalityType;
    spaceId: string;
    dimension: number;
    inputHash: string;
    documentId?: string;
    sourceFileId?: string;
    inputText?: string;
    inputTitle?: string;
}

export type EmbeddingRow = typeof AssetEmbedding.$inferSelect;

/** Retires READY vectors of the same media, role and space that belong to other inputs. */
async function retireOtherInputs(
    tx: Transaction,
    row: Pick<EmbeddingRow, "entity_id" | "embedding_role" | "embedding_space_id" | "content_hash">,
) {
    await tx
        .update(AssetEmbedding)
        .set({ embedding_status: EmbeddingStatus.STALE, update_time: sql`now()` })
        .where(
            and(
                eq(AssetEmbedding.entity_type, EntityType.MEDIA),
                eq(AssetEmbedding.entity_id, row.entity_id),
                eq(AssetEmbedding.embedding_role, row.embedding_role),
                eq(AssetEmbedding.embedding_space_id, row.embedding_space_id),
                eq(AssetEmbedding.embedding_status, EmbeddingStatus.READY),
                ne(AssetEmbedding.content_hash, row.content_hash),
            ),
        );
}

/**
 * Makes sure each request has a current or queued vector. Returns how many rows were queued.
 * The previous READY vector keeps serving search until the queued one completes.
 */
export async function enqueueEmbeddings(tx: Transaction, requests: EmbeddingRequest[]): Promise<number> {
    let queued = 0;
    for (const request of requests) {
        const existing = (
            await tx
                .select({
                    id: AssetEmbedding.id,
                    status: AssetEmbedding.embedding_status,
                    hasVector: sql<boolean>`${AssetEmbedding.embedding} is not null`,
                })
                .from(AssetEmbedding)
                .where(
                    and(
                        eq(AssetEmbedding.entity_type, EntityType.MEDIA),
                        eq(AssetEmbedding.entity_id, request.mediaId),
                        eq(AssetEmbedding.embedding_space_id, request.spaceId),
                        eq(AssetEmbedding.embedding_role, request.role),
                        eq(AssetEmbedding.content_hash, request.inputHash),
                    ),
                )
                .limit(1)
        )[0];

        if (existing?.status === EmbeddingStatus.READY) continue;

        if (existing?.hasVector) {
            // The input changed back to one we already embedded: reuse the stored vector.
            await tx
                .update(AssetEmbedding)
                .set({ embedding_status: EmbeddingStatus.READY, document_id: request.documentId, update_time: sql`now()` })
                .where(eq(AssetEmbedding.id, existing.id));
            await retireOtherInputs(tx, {
                entity_id: request.mediaId,
                embedding_role: request.role,
                embedding_space_id: request.spaceId,
                content_hash: request.inputHash,
            });
            continue;
        }

        const queuedRow = {
            library_id: request.libraryId,
            document_id: request.documentId,
            source_file_id: request.sourceFileId,
            input_text: request.inputText ?? null,
            input_title: request.inputTitle ?? null,
            embedding_status: EmbeddingStatus.PENDING,
            available_at: sql`now()`,
            attempt_count: 0,
            last_error: null,
            error_kind: null,
            update_time: sql`now()`,
        };
        if (existing) {
            if (existing.status === EmbeddingStatus.PENDING) continue;
            await tx.update(AssetEmbedding).set(queuedRow).where(eq(AssetEmbedding.id, existing.id));
        } else {
            await tx.insert(AssetEmbedding).values({
                ...queuedRow,
                entity_type: EntityType.MEDIA,
                entity_id: request.mediaId,
                embedding_space_id: request.spaceId,
                embedding_role: request.role,
                input_modality: request.modality,
                dimension: request.dimension,
                content_hash: request.inputHash,
            });
        }
        queued += 1;
    }
    return queued;
}

/** Wakes embedding workers on every server instance. */
export async function notifyEmbeddingQueue(): Promise<void> {
    await kv.publish(EMBEDDING_QUEUE_CHANNEL, "1").catch((error: unknown) => {
        console.warn("[AI EMBED] Failed to publish a queue wake-up; workers will poll.", error);
    });
}

/**
 * Vectors of media that are neither deleted nor in the recycle bin. Work for recycled media
 * waits (and does not block space promotion) until the media is restored.
 */
export const ofActiveMedia = sql`exists (
    select 1 from ${Media}
    where ${Media.id} = ${AssetEmbedding.entity_id}
      and ${Media.delete_status} = ${DeleteStatus.ACTIVE}
      and ${Media.recycle_time} is null
)`;

/** Rows a worker may take: due and belonging to live media. */
const claimable = and(
    eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING),
    lte(AssetEmbedding.available_at, sql`now()`),
    ofActiveMedia,
);

/** Pushes `available_at` forward so other workers skip the rows while this one works on them. */
async function claimRows(where: ReturnType<typeof and>, limit: number): Promise<EmbeddingRow[]> {
    return db.transaction(async (tx) => {
        const candidates = await tx
            .select({ id: AssetEmbedding.id })
            .from(AssetEmbedding)
            .where(and(claimable, where))
            .orderBy(asc(AssetEmbedding.available_at), asc(AssetEmbedding.create_time))
            .limit(limit)
            .for("update", { skipLocked: true });
        if (candidates.length === 0) return [];
        return tx
            .update(AssetEmbedding)
            .set({ available_at: sql`now() + (${CLAIM_LEASE_SECONDS} * interval '1 second')` })
            .where(
                inArray(
                    AssetEmbedding.id,
                    candidates.map((row) => row.id),
                ),
            )
            .returning();
    });
}

interface ResolvedBatchProvider {
    service: AiService;
    textProvider?: TextEmbeddingProvider;
    imageProvider?: VisualEmbeddingProvider;
}

/** Finds the provider that writes `spaceId` for the library, whether that space is active or building. */
async function resolveBatchProvider(row: EmbeddingRow): Promise<ResolvedBatchProvider | null> {
    const service = await AiService.forLibrary(row.library_id, "background");
    if (!service) return null;
    const matches = <P extends { spaceId: string }>(providers: { active: P | null; building: P | null }) =>
        [providers.active, providers.building].find((provider) => provider?.spaceId === row.embedding_space_id) ?? undefined;

    if (row.input_modality === ModalityType.IMAGE) {
        const imageProvider = matches(service.imageEmbedding);
        return imageProvider ? { service, imageProvider } : null;
    }
    const textProvider = matches(service.textEmbedding);
    return textProvider ? { service, textProvider } : null;
}

/** Whether the row's library still writes the row's space (ACTIVE or BUILDING; RETIRED spaces are read-only). */
async function libraryWritesSpace(row: EmbeddingRow): Promise<boolean> {
    const spaces = await db
        .select({ id: LibraryEmbeddingSpace.id })
        .from(LibraryEmbeddingSpace)
        .where(
            and(
                eq(LibraryEmbeddingSpace.library_id, row.library_id),
                eq(LibraryEmbeddingSpace.space_id, row.embedding_space_id),
                inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
            ),
        )
        .limit(1);
    return spaces.length > 0;
}

async function downloadImages(rows: EmbeddingRow[], signal?: AbortSignal) {
    const fileIds = rows.flatMap((row) => (row.source_file_id ? [row.source_file_id] : []));
    const files = fileIds.length > 0 ? await db.select().from(DbFile).where(inArray(DbFile.id, fileIds)) : [];
    return Promise.all(
        rows.map(async (row) => {
            const file = files.find((item) => item.id === row.source_file_id);
            if (!file) throw new Error(`Source file of embedding ${row.id} no longer exists`);
            return { imageBuffer: await readAiSourceImage(file, signal), mimeType: file.mime_type };
        }),
    );
}

/** Stores vectors for claimed rows (aligned by index) and retires the vectors they replace. */
export async function storeEmbeddingResults(rows: EmbeddingRow[], results: EmbeddingResult[]) {
    await db.transaction(async (tx) => {
        for (const [index, row] of rows.entries()) {
            const result = results[index]!;
            const updated = await tx
                .update(AssetEmbedding)
                .set({
                    embedding: result.embedding,
                    embedding_status: EmbeddingStatus.READY,
                    input_text: null,
                    input_title: null,
                    last_error: null,
                    error_kind: null,
                    update_time: sql`now()`,
                })
                .where(and(eq(AssetEmbedding.id, row.id), eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING)))
                .returning({ id: AssetEmbedding.id });
            if (updated.length > 0) await retireOtherInputs(tx, row);
        }
    });
}

/**
 * Returns rows of a failed request to the queue: throttling only delays them, other errors
 * count an attempt, and non-retryable errors or exhausted attempts mark them FAILED.
 */
export async function rescheduleFailedRows(rows: EmbeddingRow[], error: unknown) {
    const classification = classifyAiError(error);
    const message = getSafeAiErrorMessage(error);
    const ids = rows.map((row) => row.id);

    if (error instanceof AiThrottledError) {
        // Nothing was sent: release the rows without counting an attempt.
        await db
            .update(AssetEmbedding)
            .set({ available_at: sql`now() + (${Math.ceil(error.retryAfterMs / 1000)} * interval '1 second')` })
            .where(inArray(AssetEmbedding.id, ids));
        return;
    }

    for (const row of rows) {
        const attempts = row.attempt_count + 1;
        const giveUp = !classification.retryable || attempts >= MAX_EMBEDDING_ATTEMPTS;
        const delaySeconds = Math.max(retryDelaySeconds(attempts), Math.ceil((classification.retryAfterMs ?? 0) / 1000));
        await db
            .update(AssetEmbedding)
            .set({
                attempt_count: attempts,
                last_error: message,
                error_kind: classification.kind,
                update_time: sql`now()`,
                ...(giveUp
                    ? { embedding_status: EmbeddingStatus.FAILED }
                    : { available_at: sql`now() + (${delaySeconds} * interval '1 second')` }),
            })
            .where(and(eq(AssetEmbedding.id, row.id), eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING)));
    }
}

/**
 * Claims and embeds one batch. Returns the claimed rows (empty when the queue has no due work).
 *
 * A row that already failed is retried on its own, so one bad input cannot keep failing a batch.
 */
export async function processNextEmbeddingBatch(signal?: AbortSignal): Promise<EmbeddingRow[]> {
    const [head] = await claimRows(undefined, 1);
    if (!head) return [];

    let rows = [head];
    try {
        const provider = await resolveBatchProvider(head);
        if (!provider) {
            if (!(await libraryWritesSpace(head))) {
                // The library no longer writes this space (model changed or removed); the request is obsolete.
                await db.delete(AssetEmbedding).where(eq(AssetEmbedding.id, head.id));
                return rows;
            }
            // The space is still configured but its model could not be resolved (invalid model, unreadable
            // key, database hiccup): keep the request and retry it like a failed call.
            throw new AiProviderError("TRANSIENT", `No provider could be resolved for embedding space ${head.embedding_space_id}`);
        }

        const batchSize = provider.imageProvider ? provider.imageProvider.imageBatchSize : provider.textProvider!.textBatchSize;
        if (head.attempt_count === 0 && batchSize > 1) {
            const more = await claimRows(
                and(
                    eq(AssetEmbedding.library_id, head.library_id),
                    eq(AssetEmbedding.embedding_space_id, head.embedding_space_id),
                    eq(AssetEmbedding.input_modality, head.input_modality),
                    eq(AssetEmbedding.attempt_count, 0),
                ),
                batchSize - 1,
            );
            rows = [head, ...more];
        }

        let results: EmbeddingResult[];
        if (provider.imageProvider) {
            const images = await downloadImages(rows, signal);
            results = await provider.service.embedImages(provider.imageProvider, images, signal);
        } else {
            const inputs = rows.map((row) => {
                if (row.input_text === null) throw new Error(`Embedding ${row.id} has no input text`);
                return { text: row.input_text, title: row.input_title ?? undefined, purpose: "DOCUMENT" as const };
            });
            results = await provider.service.embedDocuments(provider.textProvider!, inputs, signal);
        }
        await storeEmbeddingResults(rows, results);
    } catch (error) {
        await rescheduleFailedRows(rows, error);
        if (!(error instanceof AiThrottledError)) {
            console.error(`[AI EMBED] Batch of ${rows.length} in space ${head.embedding_space_id} failed:`, error);
        }
    }
    return rows;
}

/** Queued, failed and stored vectors of one library space, for progress reporting. */
/**
 * Vectors of a library space by status, and how many media they cover: while a new input is queued,
 * a media item keeps its previous vector, so it can have more than one row.
 */
export async function countEmbeddings(libraryId: string, spaceId: string, role: EmbeddingRole) {
    const isStatus = (status: EmbeddingStatus) => sql`${AssetEmbedding.embedding_status} = ${status}`;
    const [counts] = await db
        .select({
            total: sql<number>`count(distinct ${AssetEmbedding.entity_id})::int`,
            ready: sql<number>`(count(*) filter (where ${isStatus(EmbeddingStatus.READY)}))::int`,
            pending: sql<number>`(count(*) filter (where ${isStatus(EmbeddingStatus.PENDING)}))::int`,
            failed: sql<number>`(count(*) filter (where ${isStatus(EmbeddingStatus.FAILED)}))::int`,
        })
        .from(AssetEmbedding)
        .where(
            and(
                eq(AssetEmbedding.library_id, libraryId),
                eq(AssetEmbedding.embedding_space_id, spaceId),
                eq(AssetEmbedding.embedding_role, role),
                ofActiveMedia,
            ),
        );
    return counts!;
}

/** The latest error of a library space's queued or failed vectors; null once they have all been stored. */
export async function latestEmbeddingError(libraryId: string, spaceId: string, role: EmbeddingRole): Promise<AiErrorView | null> {
    const [row] = await db
        .select({ message: AssetEmbedding.last_error, at: AssetEmbedding.update_time })
        .from(AssetEmbedding)
        .where(
            and(
                eq(AssetEmbedding.library_id, libraryId),
                eq(AssetEmbedding.embedding_space_id, spaceId),
                eq(AssetEmbedding.embedding_role, role),
                inArray(AssetEmbedding.embedding_status, [EmbeddingStatus.PENDING, EmbeddingStatus.FAILED]),
                isNotNull(AssetEmbedding.last_error),
                ofActiveMedia,
            ),
        )
        .orderBy(desc(AssetEmbedding.update_time))
        .limit(1);
    return row?.message && row.at ? { message: row.message, at: row.at.toString() } : null;
}

/** Puts FAILED vectors of the spaces a library writes back in the queue. Returns how many were requeued. */
export async function retryFailedEmbeddings(libraryId: string): Promise<number> {
    const writtenSpaceIds = db
        .select({ space_id: LibraryEmbeddingSpace.space_id })
        .from(LibraryEmbeddingSpace)
        .where(
            and(
                eq(LibraryEmbeddingSpace.library_id, libraryId),
                inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
            ),
        );
    const updated = await db
        .update(AssetEmbedding)
        .set({ embedding_status: EmbeddingStatus.PENDING, attempt_count: 0, available_at: sql`now()`, update_time: sql`now()` })
        .where(
            and(
                eq(AssetEmbedding.library_id, libraryId),
                eq(AssetEmbedding.embedding_status, EmbeddingStatus.FAILED),
                inArray(AssetEmbedding.embedding_space_id, writtenSpaceIds),
            ),
        )
        .returning({ id: AssetEmbedding.id });
    if (updated.length > 0) await notifyEmbeddingQueue();
    return updated.length;
}
