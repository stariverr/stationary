import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
    AssetSearchDocument,
    EntityType,
    AiModel,
    AiProvider,
    AssetEmbedding,
    AsyncTask,
    AsyncTaskStatus,
    EmbeddingRole,
    EmbeddingStatus,
    Library,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
    MediaType,
    ModalityType,
} from "@/db/schema";
import { db } from "@/global/db";
import { kv } from "@/global/kv";
import { secretBox } from "@/global/secrets";
import { enqueueEmbeddings, processNextEmbeddingBatch, retryFailedEmbeddings } from "@/features/ai/embedding-queue";
import { clearModelBindings, getLibraryBindings, getRolesUsingModel, saveLibraryBindings } from "@/features/ai/bindings";
import { getLibraryEmbeddingStatus, promoteBuiltSpaces, syncEmbeddingSpace } from "@/features/ai/embedding-spaces";
import { getLibraryAiStatus } from "@/features/ai/status";
import { batchDeleteMedia } from "@/features/media/lifecycle";
import { createRedisRateLimitStore } from "@/features/ai/rate-limit";
import { HybridSearchService } from "@/features/ai/search";
import { AiService } from "@/features/ai/service";
import { initJobHandlers } from "@/infra/jobs/register-handlers";

/**
 * Exercises the embedding queue, worker batches, vector search and space promotion against a real
 * PostgreSQL with pgvector and Redis. Provider HTTP calls are answered by a fake DashScope.
 * Run with RUN_AI_DB_TESTS=1 and DB_URL / REDIS_URL pointing at disposable instances.
 */
const databaseTest = process.env.RUN_AI_DB_TESTS === "1" ? test : test.skip;

const ownerId = crypto.randomUUID();
const libraryId = crypto.randomUUID();
const mediaIds = { cat: crypto.randomUUID(), dog: crypto.randomUUID(), car: crypto.randomUUID() };
let providerId = "";
let modelA = "";
let modelB = "";

const capabilities = (dimension: number) => ({
    dimension,
    mrl: true,
    maxInputTokens: 8192,
    multimodal: true,
    imageFormats: ["image/jpeg"],
});

/** One-hot vectors: texts mentioning the same animal land on the same axis. */
function fakeVector(text: string, dimension: number): number[] {
    const axis = text.includes("cat") ? 0 : text.includes("dog") ? 1 : 2;
    return Array.from({ length: dimension }, (_, index) => (index === axis ? 1 : 0));
}

const requests: Array<{ contents: Array<{ text?: string }>; dimension: number }> = [];
let failNextRequest = false;
const originalFetch = globalThis.fetch;

function fakeDashScope() {
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.url.startsWith("https://rerank.test/")) return fakeRerank(request);
        if (!request.url.includes("multimodal-embedding")) return originalFetch(input, init);
        const body = (await request.json()) as { input: { contents: Array<{ text?: string }> }; parameters?: { dimension?: number } };
        const dimension = body.parameters?.dimension ?? 1024;
        requests.push({ contents: body.input.contents, dimension });
        if (failNextRequest) {
            failNextRequest = false;
            return new Response(JSON.stringify({ message: "bad input" }), { status: 400, headers: { "content-type": "application/json" } });
        }
        const embeddings = body.input.contents.map((content, index) => ({
            index,
            type: "text",
            embedding: fakeVector(content.text ?? "", dimension),
        }));
        return new Response(JSON.stringify({ output: { embeddings } }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
}

/** Cohere-style /rerank: documents mentioning "dog" rank first. */
let rerankCalls = 0;
let rerankFails = false;
async function fakeRerank(request: Request): Promise<Response> {
    rerankCalls += 1;
    if (rerankFails) return new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    const body = (await request.json()) as { documents: string[] };
    const results = body.documents.map((document, index) => ({ index, relevance_score: document.includes("dog") ? 0.9 : 0.1 }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
}

async function queueDocuments(spaceId: string, dimension: number, suffix = "") {
    return db.transaction((tx) =>
        enqueueEmbeddings(
            tx,
            Object.entries(mediaIds).map(([animal, mediaId]) => ({
                libraryId,
                mediaId,
                role: EmbeddingRole.AI_CAPTION,
                modality: ModalityType.TEXT,
                spaceId,
                dimension,
                inputHash: `${animal}${suffix}`,
                inputText: `Media Title: a ${animal}${suffix}`,
                inputTitle: animal,
            })),
        ),
    );
}

async function rowsIn(spaceId: string) {
    return db
        .select()
        .from(AssetEmbedding)
        .where(and(eq(AssetEmbedding.library_id, libraryId), eq(AssetEmbedding.embedding_space_id, spaceId)));
}

async function spaces() {
    return db.select().from(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.library_id, libraryId));
}

describe("AI embedding queue (PostgreSQL + Redis)", () => {
    beforeAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        initJobHandlers();
        fakeDashScope();
        await db.insert(Library).values({ id: libraryId, name: "AI test", description: "", owner_id: ownerId });
        await db.insert(Media).values(
            Object.entries(mediaIds).map(([animal, id], index) => ({
                id,
                library_id: libraryId,
                eid: `ai-test-${id}`,
                title: animal,
                description: "",
                type: MediaType.IMAGE,
                sort_order: index,
            })),
        );
        const [provider] = await db
            .insert(AiProvider)
            .values({
                owner_id: ownerId,
                template_id: "dashscope-native",
                name: "Fake DashScope",
                base_url: "https://dashscope.aliyuncs.com",
                api_key_ciphertext: secretBox.encrypt("test-key"),
            })
            .returning();
        providerId = provider!.id;
        const [a, b] = await db
            .insert(AiModel)
            .values([
                { provider_id: providerId, name: "qwen3-vl-embedding", display_name: "Qwen3-VL Embedding", category: "embedding", capabilities: capabilities(1024) },
                { provider_id: providerId, name: "qwen3-vl-embedding", display_name: "Qwen3-VL Embedding", category: "embedding", capabilities: capabilities(768) },
            ])
            .returning();
        modelA = a!.id;
        modelB = b!.id;
    });

    afterAll(async () => {
        globalThis.fetch = originalFetch;
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.delete(AssetEmbedding).where(eq(AssetEmbedding.library_id, libraryId));
        await db.delete(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.library_id, libraryId));
        await db.delete(AsyncTask).where(eq(AsyncTask.library_id, libraryId));
        await db.delete(Media).where(inArray(Media.id, Object.values(mediaIds)));
        await db.delete(AiModel).where(eq(AiModel.provider_id, providerId));
        await db.delete(AiProvider).where(eq(AiProvider.id, providerId));
        await db.delete(Library).where(eq(Library.id, libraryId));
    });

    databaseTest("embeds queued documents in one batch and searches them through the vector index", async () => {
        await syncEmbeddingSpace({ id: libraryId, owner_id: ownerId }, "textEmbedding", modelA);
        const [active] = await spaces();
        expect(active).toMatchObject({ status: LibraryEmbeddingSpaceStatus.ACTIVE, space_id: "qwen3-vl-embedding:1024:plain" });

        expect(await queueDocuments(active!.space_id, 1024)).toBe(3);
        const claimed = await processNextEmbeddingBatch();
        expect(claimed).toHaveLength(3);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.contents).toHaveLength(3);

        const rows = await rowsIn(active!.space_id);
        expect(rows.every((row) => row.embedding_status === EmbeddingStatus.READY && row.embedding?.length === 1024)).toBe(true);
        expect(rows.every((row) => row.input_text === null)).toBe(true);

        // Queuing the same inputs again is a no-op.
        expect(await queueDocuments(active!.space_id, 1024)).toBe(0);

        const service = await AiService.forLibrary(libraryId, "interactive");
        const query = await service!.embedQuery("textEmbedding", "cat");
        const results = await HybridSearchService.vectorSearch(query, EmbeddingRole.AI_CAPTION, 0.5, libraryId, 10, {
            library_id: libraryId,
            keyword: "cat",
        });
        expect(results.map((result) => result.id)).toEqual([mediaIds.cat]);
    });

    databaseTest("builds a new space beside the active one and promotes it once the backfill drains", async () => {
        await syncEmbeddingSpace({ id: libraryId, owner_id: ownerId }, "textEmbedding", modelB);
        const building = (await spaces()).find((space) => space.status === LibraryEmbeddingSpaceStatus.BUILDING);
        expect(building?.space_id).toBe("qwen3-vl-embedding:768:plain");

        const service = await AiService.forLibrary(libraryId);
        expect(service!.textEmbedding.active?.spaceId).toBe("qwen3-vl-embedding:1024:plain");
        expect(service!.textEmbedding.building?.spaceId).toBe("qwen3-vl-embedding:768:plain");

        await queueDocuments(building!.space_id, 768);
        expect(await processNextEmbeddingBatch()).toHaveLength(3);

        // The backfill task has not finished yet, so the old space keeps serving.
        expect(await promoteBuiltSpaces()).toBe(0);
        await db.update(AsyncTask).set({ status: AsyncTaskStatus.COMPLETED }).where(eq(AsyncTask.id, building!.backfill_task_id!));
        expect(await promoteBuiltSpaces()).toBe(1);

        // The replaced space is retired, not dropped: its vectors stay for switching back.
        const remaining = await spaces();
        expect(remaining).toHaveLength(2);
        expect(remaining.find((space) => space.status === LibraryEmbeddingSpaceStatus.ACTIVE)?.space_id).toBe("qwen3-vl-embedding:768:plain");
        expect(remaining.find((space) => space.status === LibraryEmbeddingSpaceStatus.RETIRED)?.space_id).toBe("qwen3-vl-embedding:1024:plain");
        expect(await rowsIn("qwen3-vl-embedding:1024:plain")).toHaveLength(3);
        expect((await AiService.forLibrary(libraryId))!.textEmbedding.active?.spaceId).toBe("qwen3-vl-embedding:768:plain");
    });

    databaseTest("switches back to a retired space without re-embedding and holds back a space that mostly failed", async () => {
        const completeBackfill = async () => {
            const building = (await spaces()).find((space) => space.status === LibraryEmbeddingSpaceStatus.BUILDING);
            await db.update(AsyncTask).set({ status: AsyncTaskStatus.COMPLETED }).where(eq(AsyncTask.id, building!.backfill_task_id!));
            return building!;
        };
        const requestsBefore = requests.length;

        // Choosing the previous model again revives its retired space; its vectors are still READY.
        await syncEmbeddingSpace({ id: libraryId, owner_id: ownerId }, "textEmbedding", modelA);
        expect((await completeBackfill()).space_id).toBe("qwen3-vl-embedding:1024:plain");
        expect(await promoteBuiltSpaces()).toBe(1);
        expect(requests.length).toBe(requestsBefore);
        expect((await spaces()).find((space) => space.status === LibraryEmbeddingSpaceStatus.ACTIVE)?.space_id).toBe(
            "qwen3-vl-embedding:1024:plain",
        );

        // Switch back again, but this time every vector of the new space failed (e.g. a wrong key).
        await syncEmbeddingSpace({ id: libraryId, owner_id: ownerId }, "textEmbedding", modelB);
        await completeBackfill();
        await db
            .update(AssetEmbedding)
            .set({ embedding_status: EmbeddingStatus.FAILED })
            .where(and(eq(AssetEmbedding.library_id, libraryId), eq(AssetEmbedding.embedding_space_id, "qwen3-vl-embedding:768:plain")));
        expect(await promoteBuiltSpaces()).toBe(0);
        const blocked = (await getLibraryEmbeddingStatus(libraryId)).spaces.find((space) => space.status === LibraryEmbeddingSpaceStatus.BUILDING);
        expect(blocked).toMatchObject({ spaceId: "qwen3-vl-embedding:768:plain", blocked: "too_many_failures" });
        // The active space and its vectors are untouched.
        expect((await rowsIn("qwen3-vl-embedding:1024:plain")).filter((row) => row.embedding_status === EmbeddingStatus.READY)).toHaveLength(3);

        // Once the vectors are back, the space is promoted.
        await db
            .update(AssetEmbedding)
            .set({ embedding_status: EmbeddingStatus.READY })
            .where(and(eq(AssetEmbedding.library_id, libraryId), eq(AssetEmbedding.embedding_space_id, "qwen3-vl-embedding:768:plain")));
        expect(await promoteBuiltSpaces()).toBe(1);
        expect((await spaces()).find((space) => space.status === LibraryEmbeddingSpaceStatus.ACTIVE)?.space_id).toBe(
            "qwen3-vl-embedding:768:plain",
        );
    });

    databaseTest("fails rejected inputs, retries them on demand, and defers throttled batches without counting attempts", async () => {
        const spaceId = "qwen3-vl-embedding:768:plain";
        await queueDocuments(spaceId, 768, " v2");

        failNextRequest = true;
        await processNextEmbeddingBatch();
        const failed = (await rowsIn(spaceId)).filter((row) => row.content_hash.endsWith(" v2"));
        expect(failed.every((row) => row.embedding_status === EmbeddingStatus.FAILED && row.attempt_count === 1)).toBe(true);
        // The previous vectors keep serving search while the new input is unresolved.
        expect((await rowsIn(spaceId)).filter((row) => row.embedding_status === EmbeddingStatus.READY)).toHaveLength(3);
        // Settings show the provider's error next to the failed count.
        const status = await getLibraryAiStatus(libraryId);
        const space = status.spaces.find((view) => view.spaceId === spaceId && view.status === LibraryEmbeddingSpaceStatus.ACTIVE);
        expect(space?.failed).toBe(3);
        expect(space?.lastError?.message).toContain("bad input");
        expect(status.issues).toEqual([]);

        expect(await retryFailedEmbeddings(libraryId)).toBe(3);
        await createRedisRateLimitStore(kv).coolDown(providerId, 5_000);
        const deferred = await processNextEmbeddingBatch();
        expect(deferred.length).toBeGreaterThan(0);
        const afterThrottle = (await rowsIn(spaceId)).filter((row) => row.content_hash.endsWith(" v2"));
        expect(afterThrottle.every((row) => row.embedding_status === EmbeddingStatus.PENDING && row.attempt_count === 0)).toBe(true);
    });
    databaseTest("pauses work for recycled media and removes AI data of deleted media", async () => {
        const spaceId = "qwen3-vl-embedding:768:plain";
        await db
            .update(Media)
            .set({ recycle_time: sql`now()` })
            .where(eq(Media.id, mediaIds.car));
        await db.transaction((tx) =>
            enqueueEmbeddings(tx, [
                {
                    libraryId,
                    mediaId: mediaIds.car,
                    role: EmbeddingRole.AI_CAPTION,
                    modality: ModalityType.TEXT,
                    spaceId,
                    dimension: 768,
                    inputHash: "car v3",
                    inputText: "a red car",
                },
            ]),
        );
        await db
            .update(AssetEmbedding)
            .set({ available_at: sql`now()` })
            .where(and(eq(AssetEmbedding.library_id, libraryId), eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING)));

        // Recycled: not claimed, and invisible to progress counts.
        const claimed = await processNextEmbeddingBatch();
        expect(claimed.some((row) => row.entity_id === mediaIds.car)).toBe(false);
        expect((await getLibraryEmbeddingStatus(libraryId)).mediaTotal).toBe(2);

        // Restored: claimable again.
        await db.update(Media).set({ recycle_time: null }).where(eq(Media.id, mediaIds.car));
        await db
            .update(AssetEmbedding)
            .set({ available_at: sql`now()` })
            .where(and(eq(AssetEmbedding.entity_id, mediaIds.car), eq(AssetEmbedding.embedding_status, EmbeddingStatus.PENDING)));
        expect((await processNextEmbeddingBatch()).some((row) => row.entity_id === mediaIds.car)).toBe(true);

        // Deleted for good: every AI row of the media is gone.
        await batchDeleteMedia([mediaIds.cat]);
        const leftovers = await db.select({ id: AssetEmbedding.id }).from(AssetEmbedding).where(eq(AssetEmbedding.entity_id, mediaIds.cat));
        expect(leftovers).toHaveLength(0);
    });

    databaseTest("saves role bindings atomically and reads embedding roles from their spaces", async () => {
        const library = { id: libraryId, owner_id: ownerId };
        const before = await getLibraryBindings(libraryId);

        // The embedding model does not exist, so nothing else in the request may be applied either.
        await expect(
            saveLibraryBindings(library, { rerank: { modelId: modelA }, imageEmbedding: { modelId: crypto.randomUUID() } }),
        ).rejects.toThrow();
        expect(await getLibraryBindings(libraryId)).toEqual(before);

        await saveLibraryBindings(library, { rerank: { modelId: modelA }, imageEmbedding: { modelId: modelA } });
        expect(await getLibraryBindings(libraryId)).toMatchObject({ rerank: { modelId: modelA }, imageEmbedding: { modelId: modelA } });
        // The library row holds only the roles that have no space.
        const [row] = await db.select({ ai_bindings: Library.ai_bindings }).from(Library).where(eq(Library.id, libraryId));
        expect(row!.ai_bindings).toEqual({ rerank: { modelId: modelA } });
        // A RETIRED text space of modelA does not count as use.
        expect(await getRolesUsingModel(ownerId, modelA)).toEqual(["imageEmbedding", "rerank"]);

        // Saving again starts the backfill of a space whose earlier start failed.
        const imageSpace = () => spaces().then((rows) => rows.find((space) => space.role === "imageEmbedding")!);
        await db.update(LibraryEmbeddingSpace).set({ backfill_task_id: null }).where(eq(LibraryEmbeddingSpace.id, (await imageSpace()).id));
        expect(await saveLibraryBindings(library, { imageEmbedding: { modelId: modelA } })).toEqual({ indexingStarted: true });
        expect((await imageSpace()).backfill_task_id).not.toBeNull();

        // Deleting the model clears every role that used it, spaces included.
        await db.transaction((tx) => clearModelBindings(tx, ownerId, [modelA]));
        expect(await getRolesUsingModel(ownerId, modelA)).toEqual([]);
        expect((await getLibraryBindings(libraryId)).rerank).toBeNull();
    });
});

describe("AI search reranking (PostgreSQL + Redis)", () => {
    const rerankOwnerId = crypto.randomUUID();
    const rerankLibraryId = crypto.randomUUID();
    const media = { cat: crypto.randomUUID(), dog: crypto.randomUUID(), car: crypto.randomUUID() };
    let rerankProviderId = "";

    beforeAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        fakeDashScope();
        const [provider] = await db
            .insert(AiProvider)
            .values({
                owner_id: rerankOwnerId,
                template_id: "custom-openai-compatible",
                name: "Fake reranker",
                base_url: "https://rerank.test/v1",
            })
            .returning();
        rerankProviderId = provider!.id;
        const [model] = await db
            .insert(AiModel)
            .values({ provider_id: rerankProviderId, name: "fake-reranker", display_name: "Fake Reranker", category: "rerank", capabilities: { maxInputTokens: 512 } })
            .returning();
        await db.insert(Library).values({
            id: rerankLibraryId,
            name: "AI rerank test",
            description: "",
            owner_id: rerankOwnerId,
            ai_bindings: { rerank: { modelId: model!.id } },
        });
        const entries = Object.entries(media);
        await db.insert(Media).values(
            entries.map(([animal, id], index) => ({
                id,
                library_id: rerankLibraryId,
                eid: `ai-rerank-${id}`,
                title: animal,
                description: "",
                type: MediaType.IMAGE,
                sort_order: index,
            })),
        );
        await db.insert(AssetSearchDocument).values(
            entries.map(([animal, id]) => ({
                library_id: rerankLibraryId,
                entity_type: EntityType.MEDIA,
                entity_id: id,
                source: "MANUAL",
                title: animal,
                content: `Media Title: a ${animal}`,
                content_hash: animal,
            })),
        );
    });

    afterAll(async () => {
        globalThis.fetch = originalFetch;
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.delete(AssetSearchDocument).where(eq(AssetSearchDocument.library_id, rerankLibraryId));
        await db.delete(Media).where(eq(Media.library_id, rerankLibraryId));
        await db.delete(Library).where(eq(Library.id, rerankLibraryId));
        await db.delete(AiModel).where(eq(AiModel.provider_id, rerankProviderId));
        await db.delete(AiProvider).where(eq(AiProvider.id, rerankProviderId));
    });

    databaseTest("reorders fused results by reranker score and reuses it across pages", async () => {
        const first = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "a ", count: 2, page: 1 }, rerankOwnerId);
        expect(first.total).toBe(3);
        expect(first.list[0]?.id).toBe(media.dog);
        expect(first.list[0]?.matched_details?.rerank?.score).toBe(0.9);

        const second = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "a ", count: 2, page: 2 }, rerankOwnerId);
        expect(second.list).toHaveLength(1);
        expect(rerankCalls).toBe(1);
        expect(first.degraded).toEqual([]);
    });

    databaseTest("reports a failing reranker and an unusable model as degraded channels", async () => {
        rerankFails = true;
        try {
            const result = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "dog" }, rerankOwnerId);
            expect(result.list.map((item) => item.id)).toEqual([media.dog]);
            expect(result.degraded).toEqual([{ channel: "rerank", reason: "TRANSIENT" }]);
        } finally {
            rerankFails = false;
        }

        // A bound model that no longer resolves leaves its channel out and says so.
        await db
            .update(Library)
            .set({ ai_bindings: { rerank: { modelId: crypto.randomUUID() } } })
            .where(eq(Library.id, rerankLibraryId));
        const unresolved = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "cat" }, rerankOwnerId);
        expect(unresolved.list.map((item) => item.id)).toEqual([media.cat]);
        expect(unresolved.degraded).toEqual([{ channel: "rerank", reason: "CONFIGURATION" }]);
    });
});
