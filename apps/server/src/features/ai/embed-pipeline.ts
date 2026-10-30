import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
    AssetEmbedding,
    AssetSearchDocument,
    DeleteStatus,
    EntityType,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
    ModalityType,
    Track,
} from "@/db/schema";
import { db, type DbClient, type Transaction } from "@/global/db";
import { LeaseLostError } from "@/infra/queue/store";
import type { BatchPipelineHandler, ReconcileResult } from "@/infra/queue/types";
import { AiProviderError } from "./errors";
import { dropExpiredRetiredSpaces, EMBEDDING_ROLE_FOR, promoteBuiltSpaces, promoteIfBuilt } from "./embedding-spaces";
import { aiSourceHash, loadAiEmbeddingImage, loadAiImageSources, resolveAiImageSource, type AiImageSource } from "./image-source";
import { aiErrorResult } from "./pipeline-result";
import { AiService, providerBlockedMs } from "./service";
import type { EmbedImageParams, EmbeddingBindingRole, EmbeddingResult, TextEmbeddingProvider, VisualEmbeddingProvider } from "./types";

type SpaceRow = typeof LibraryEmbeddingSpace.$inferSelect;

/** What a media's vector in a space is made from. */
type EmbeddingInput =
    /** Wait: the media is gone, or its input is still being produced (search document, cover). */
    | { kind: "wait" }
    /** Nothing to embed (empty document, no image): the media has no vector in the space. */
    | { kind: "none" }
    | { kind: "text"; hash: string; text: string; title: string }
    | { kind: "image"; hash: string; source: AiImageSource };

const done: ReconcileResult = { kind: "done" };

const activeMedia = and(eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

const ofSpaceMedia = (space: SpaceRow, mediaIds: readonly string[]) =>
    and(
        eq(AssetEmbedding.entity_type, EntityType.MEDIA),
        inArray(AssetEmbedding.entity_id, [...mediaIds]),
        eq(AssetEmbedding.library_id, space.library_id),
        eq(AssetEmbedding.embedding_space_id, space.space_id),
        eq(AssetEmbedding.embedding_role, EMBEDDING_ROLE_FOR[space.role]),
    );

async function loadSpace(client: DbClient, spaceRowId: string): Promise<SpaceRow | undefined> {
    const [space] = await client.select().from(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.id, spaceRowId)).limit(1);
    return space;
}

/**
 * The inputs of media of the space's library. Media of another library (moved away) are left out; the pipeline drops
 * what they keep in this space.
 */
async function loadInputs(space: SpaceRow, mediaIds: readonly string[], forScan: boolean): Promise<Map<string, EmbeddingInput>> {
    const media = await db
        .select({ id: Media.id })
        .from(Media)
        .where(and(inArray(Media.id, [...mediaIds]), eq(Media.library_id, space.library_id), activeMedia));
    const ids = media.map((row) => row.id);
    const inputs = new Map<string, EmbeddingInput>();
    if (ids.length === 0) return inputs;

    if (space.role === "textEmbedding") {
        const documents = await db
            .select({
                id: AssetSearchDocument.entity_id,
                libraryId: AssetSearchDocument.library_id,
                title: AssetSearchDocument.title,
                content: AssetSearchDocument.content,
                hash: AssetSearchDocument.content_hash,
            })
            .from(AssetSearchDocument)
            .where(and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), inArray(AssetSearchDocument.entity_id, ids)));
        const byId = new Map(documents.map((document) => [document.id, document]));
        for (const id of ids) {
            const document = byId.get(id);
            // ai.index writes the document; its change queues the media again.
            if (!document || document.libraryId !== space.library_id) inputs.set(id, { kind: "wait" });
            else if (!document.content) inputs.set(id, { kind: "none" });
            else inputs.set(id, { kind: "text", hash: document.hash, text: document.content, title: document.title });
        }
        return inputs;
    }

    if (forScan) {
        const sources = await loadAiImageSources(ids);
        for (const id of ids) {
            const source = sources.get(id);
            inputs.set(id, source ? { kind: "image", hash: aiSourceHash(source.file), source } : { kind: "none" });
        }
        return inputs;
    }
    for (const id of ids) {
        const { source, waitingForCover } = await resolveAiImageSource(id);
        if (waitingForCover) inputs.set(id, { kind: "wait" });
        else inputs.set(id, source ? { kind: "image", hash: aiSourceHash(source.file), source } : { kind: "none" });
    }
    return inputs;
}

type StoredVector = Pick<typeof AssetEmbedding.$inferSelect, "entity_id" | "content_hash" | "dimension" | "last_error" | "error_hash">;

async function loadStored(space: SpaceRow, mediaIds: readonly string[]): Promise<Map<string, StoredVector>> {
    const rows = await db
        .select({
            entity_id: AssetEmbedding.entity_id,
            content_hash: AssetEmbedding.content_hash,
            dimension: AssetEmbedding.dimension,
            last_error: AssetEmbedding.last_error,
            error_hash: AssetEmbedding.error_hash,
        })
        .from(AssetEmbedding)
        .where(ofSpaceMedia(space, mediaIds));
    return new Map(rows.map((row) => [row.entity_id, row]));
}

/**
 * Whether the stored row needs nothing for `input` (dimension is set only together with a vector). A vector with a
 * failure does: the input changed back to what the vector was made from, and embedding it again clears the failure.
 */
const isCurrent = (stored: StoredVector | undefined, input: { hash: string }) =>
    stored?.dimension != null && stored.content_hash === input.hash && stored.last_error === null;

/** Finds the provider that writes the space, whether it is ACTIVE or BUILDING. */
function spaceProvider(service: AiService, space: SpaceRow): TextEmbeddingProvider | VisualEmbeddingProvider | null {
    const providers = space.role === "textEmbedding" ? service.textEmbedding : service.imageEmbedding;
    return [providers.active, providers.building].find((provider) => provider?.spaceId === space.space_id) ?? null;
}

/** Vectors a request produced, and the result of every item it did not. */
interface Embedded {
    vectors: Map<string, EmbeddingResult>;
    failures: Map<string, ReconcileResult>;
}

/**
 * Embeds `items` in one request. An input error says that some item is at fault but not which, so the request is split
 * in half until the item stands alone; the others still get their vectors. Any other error applies to the whole request.
 */
async function embedSplittingOnInputError<T extends { id: string }>(
    items: readonly T[],
    request: (items: readonly T[]) => Promise<EmbeddingResult[]>,
): Promise<Embedded> {
    try {
        const vectors = await request(items);
        return { vectors: new Map(items.map((item, index) => [item.id, vectors[index]!])), failures: new Map() };
    } catch (error) {
        const result = aiErrorResult(error);
        if (result.kind !== "rejected" || items.length === 1) {
            return { vectors: new Map(), failures: new Map(items.map((item) => [item.id, result])) };
        }
        const middle = Math.ceil(items.length / 2);
        const first = await embedSplittingOnInputError(items.slice(0, middle), request);
        const second = await embedSplittingOnInputError(items.slice(middle), request);
        return {
            vectors: new Map([...first.vectors, ...second.vectors]),
            failures: new Map([...first.failures, ...second.failures]),
        };
    }
}

async function embedImages(
    service: AiService,
    provider: VisualEmbeddingProvider,
    items: Array<{ id: string; input: Extract<EmbeddingInput, { kind: "image" }> }>,
    signal: AbortSignal,
): Promise<Embedded> {
    const fileIds = items.map((item) => item.input.source.file.id);
    const tracks = await db
        .select({ fileId: Track.file_id, width: Track.width, height: Track.height })
        .from(Track)
        .where(and(inArray(Track.file_id, fileIds), isNotNull(Track.width), isNotNull(Track.height)));
    // Each source is loaded on its own: one unreadable file fails only its own media.
    const loaded = await Promise.allSettled(
        items.map((item) => {
            const track = tracks.find((row) => row.fileId === item.input.source.file.id);
            const dimensions = track ? { width: track.width!, height: track.height! } : undefined;
            return loadAiEmbeddingImage(item.input.source.file, dimensions, provider, signal);
        }),
    );
    const failures = new Map<string, ReconcileResult>();
    const ready: Array<{ id: string; image: EmbedImageParams }> = [];
    loaded.forEach((result, index) => {
        if (result.status === "fulfilled") ready.push({ id: items[index]!.id, image: result.value });
        else failures.set(items[index]!.id, aiErrorResult(result.reason));
    });
    if (ready.length === 0) return { vectors: new Map(), failures };

    const embedded = await embedSplittingOnInputError(ready, (batch) =>
        service.embedImages(
            provider,
            batch.map((item) => item.image),
            signal,
        ),
    );
    return { vectors: embedded.vectors, failures: new Map([...failures, ...embedded.failures]) };
}

/** Deletes the vectors of the given media in a space, inside a fenced transaction per media. */
async function dropVectors(space: SpaceRow, mediaIds: readonly string[], fence: (tx: Transaction, id: string) => Promise<void>) {
    for (const id of mediaIds) {
        await db.transaction(async (tx) => {
            await tx.delete(AssetEmbedding).where(ofSpaceMedia(space, [id]));
            await fence(tx, id);
        });
    }
}

const failedVectors = (role: EmbeddingBindingRole, libraryIds: readonly string[]) =>
    and(
        inArray(AssetEmbedding.library_id, [...libraryIds]),
        eq(AssetEmbedding.embedding_role, EMBEDDING_ROLE_FOR[role]),
        isNotNull(AssetEmbedding.last_error),
        activeMedia,
    );

/** Failed vectors join the spaces their library writes; failures of a dropped or RETIRED space no longer count. */
const ofWrittenSpace = (role: EmbeddingBindingRole) =>
    and(
        eq(LibraryEmbeddingSpace.library_id, AssetEmbedding.library_id),
        eq(LibraryEmbeddingSpace.space_id, AssetEmbedding.embedding_space_id),
        eq(LibraryEmbeddingSpace.role, role),
        inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
    );

/**
 * `ai.text` / `ai.image`: the vector of each media in one embedding space of its library, from the search document
 * (text) or the best image (image). Due media of the space share a provider request, up to the provider's batch size.
 * A media keeps its previous vector while a new one is made, and after a failure. Once a BUILDING space's queue has
 * drained, the space replaces the ACTIVE one if it covers the library.
 */
function embeddingPipeline(role: EmbeddingBindingRole): BatchPipelineHandler {
    return {
        async reconcileBatch(ctx) {
            const space = ctx.space ? await loadSpace(db, ctx.space) : undefined;
            // A dropped or RETIRED space is not written; its queue rows are left over from before.
            if (!space || space.status === LibraryEmbeddingSpaceStatus.RETIRED) return new Map([[ctx.head, done]]);

            const service = await AiService.forLibrary(space.library_id, "background");
            const provider = service ? spaceProvider(service, space) : null;
            if (!service || !provider) {
                // The space is still written but its model could not be resolved (invalid model, unreadable key).
                const error = new AiProviderError("TRANSIENT", `No provider could be resolved for embedding space ${space.space_id}`);
                return new Map([[ctx.head, aiErrorResult(error)]]);
            }

            const batchSize = role === "imageEmbedding" ? (provider as VisualEmbeddingProvider).imageBatchSize : provider.textBatchSize;
            const ids = [ctx.head, ...(batchSize > 1 ? await ctx.claimMore(batchSize - 1) : [])];
            const results = new Map<string, ReconcileResult>(ids.map((id) => [id, done]));

            const [inputs, stored] = await Promise.all([loadInputs(space, ids, false), loadStored(space, ids)]);
            // Media that left the library (or have nothing to embed) keep no vector in this space.
            await dropVectors(
                space,
                ids.filter((id) => stored.has(id) && (!inputs.has(id) || inputs.get(id)!.kind === "none")),
                ctx.fence,
            );

            const pending = ids.flatMap((id) => {
                const input = inputs.get(id);
                if (!input || input.kind === "wait" || input.kind === "none" || isCurrent(stored.get(id), input)) return [];
                return [{ id, input }];
            });
            if (pending.length === 0) return results;

            const { vectors, failures } =
                role === "imageEmbedding"
                    ? await embedImages(
                          service,
                          provider as VisualEmbeddingProvider,
                          pending.map((item) => ({ id: item.id, input: item.input as Extract<EmbeddingInput, { kind: "image" }> })),
                          ctx.signal,
                      )
                    : await embedSplittingOnInputError(
                          pending.map((item) => ({ id: item.id, ...(item.input as Extract<EmbeddingInput, { kind: "text" }>) })),
                          (texts) =>
                              service.embedDocuments(
                                  provider,
                                  texts.map((text) => ({ text: text.text, title: text.title || undefined, purpose: "DOCUMENT" as const })),
                                  ctx.signal,
                              ),
                      );
            for (const [id, result] of failures) results.set(id, result);

            for (const item of pending) {
                const vector = vectors.get(item.id);
                if (!vector) continue;
                const row = {
                    library_id: space.library_id,
                    input_modality: role === "imageEmbedding" ? ModalityType.IMAGE : ModalityType.TEXT,
                    dimension: vector.dimension,
                    embedding: vector.embedding,
                    content_hash: item.input.hash,
                    source_file_id: item.input.kind === "image" ? item.input.source.file.id : null,
                    last_error: null,
                    error_kind: null,
                    error_hash: null,
                };
                try {
                    await db.transaction(async (tx) => {
                        await tx
                            .insert(AssetEmbedding)
                            .values({
                                entity_type: EntityType.MEDIA,
                                entity_id: item.id,
                                embedding_space_id: space.space_id,
                                embedding_role: EMBEDDING_ROLE_FOR[role],
                                ...row,
                            })
                            .onConflictDoUpdate({
                                target: [
                                    AssetEmbedding.entity_type,
                                    AssetEmbedding.entity_id,
                                    AssetEmbedding.embedding_space_id,
                                    AssetEmbedding.embedding_role,
                                ],
                                set: { ...row, update_time: sql`now()` },
                            });
                        await ctx.fence(tx, item.id);
                    });
                } catch (error) {
                    // Another worker took this media over; the others of the batch are still stored.
                    if (!(error instanceof LeaseLostError)) throw error;
                }
            }
            return results;
        },

        /** Records the error, with the input when that is at fault; a stored vector stays. */
        async recordFailure(tx, { subjectId, space: spaceRowId, error, errorKind, rejected }) {
            const space = spaceRowId ? await loadSpace(tx, spaceRowId) : undefined;
            if (!space || space.status === LibraryEmbeddingSpaceStatus.RETIRED) return;
            const input = (await loadInputs(space, [subjectId], true)).get(subjectId);
            if (!input || input.kind === "wait" || input.kind === "none") return;

            const failure = { last_error: error, error_kind: errorKind, error_hash: rejected ? input.hash : null };
            await tx
                .insert(AssetEmbedding)
                .values({
                    library_id: space.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: subjectId,
                    embedding_space_id: space.space_id,
                    embedding_role: EMBEDDING_ROLE_FOR[role],
                    input_modality: role === "imageEmbedding" ? ModalityType.IMAGE : ModalityType.TEXT,
                    ...failure,
                })
                .onConflictDoUpdate({
                    target: [
                        AssetEmbedding.entity_type,
                        AssetEmbedding.entity_id,
                        AssetEmbedding.embedding_space_id,
                        AssetEmbedding.embedding_role,
                    ],
                    set: { ...failure, update_time: sql`now()` },
                });
        },

        async scanPage(libraryId, cursor, limit, spaceRowId) {
            const page = await db
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.library_id, libraryId), activeMedia, ...(cursor ? [gt(Media.id, cursor)] : [])))
                .orderBy(asc(Media.id))
                .limit(limit);
            const nextCursor = page.length === limit ? page[page.length - 1]!.id : null;
            const space = spaceRowId ? await loadSpace(db, spaceRowId) : undefined;
            if (!space || space.status === LibraryEmbeddingSpaceStatus.RETIRED || page.length === 0) return { subjectIds: [], nextCursor };

            const ids = page.map((media) => media.id);
            const [inputs, stored] = await Promise.all([loadInputs(space, ids, true), loadStored(space, ids)]);
            const subjectIds = ids.filter((id) => {
                const input = inputs.get(id);
                const row = stored.get(id);
                if (!input || input.kind === "wait") return false;
                if (input.kind === "none") return row !== undefined;
                return !isCurrent(row, input) && row?.error_hash !== input.hash;
            });
            return { subjectIds, nextCursor };
        },

        async blockedMs(libraryId) {
            const service = await AiService.forLibrary(libraryId);
            const providers = role === "imageEmbedding" ? service?.imageEmbedding : service?.textEmbedding;
            const writing = [providers?.active, providers?.building].flatMap((provider) => (provider ? [provider.providerId] : []));
            return Math.max(0, ...(await Promise.all(writing.map(providerBlockedMs))));
        },

        async countFailures(libraryIds) {
            if (libraryIds.length === 0) return new Map();
            const rows = await db
                .select({ libraryId: AssetEmbedding.library_id, count: sql<number>`count(DISTINCT ${AssetEmbedding.entity_id})::int` })
                .from(AssetEmbedding)
                .innerJoin(Media, eq(Media.id, AssetEmbedding.entity_id))
                .innerJoin(LibraryEmbeddingSpace, ofWrittenSpace(role))
                .where(failedVectors(role, libraryIds))
                .groupBy(AssetEmbedding.library_id);
            return new Map(rows.map((row) => [row.libraryId, row.count]));
        },

        async listFailures(libraryId, limit) {
            const latest = db
                .selectDistinctOn([AssetEmbedding.entity_id], {
                    subjectId: AssetEmbedding.entity_id,
                    label: Media.title,
                    error: AssetEmbedding.last_error,
                    time: AssetEmbedding.update_time,
                })
                .from(AssetEmbedding)
                .innerJoin(Media, eq(Media.id, AssetEmbedding.entity_id))
                .innerJoin(LibraryEmbeddingSpace, ofWrittenSpace(role))
                .where(failedVectors(role, [libraryId]))
                .orderBy(AssetEmbedding.entity_id, desc(AssetEmbedding.update_time))
                .as("latest");
            const query = db.select().from(latest).orderBy(desc(latest.time)).$dynamic();
            const rows = limit === undefined ? await query : await query.limit(limit);
            return rows.map((row) => ({ ...row, error: row.error ?? "" }));
        },

        async settled(_libraryId, spaceRowId) {
            await promoteIfBuilt(spaceRowId);
        },

        async patrol() {
            await promoteBuiltSpaces(role);
            await dropExpiredRetiredSpaces(role);
        },
    };
}

export const textEmbeddingPipeline = embeddingPipeline("textEmbedding");
export const imageEmbeddingPipeline = embeddingPipeline("imageEmbedding");
