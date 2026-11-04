import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
    AssetAiMetadata,
    AssetSearchDocument,
    EntityType,
    File as DbFile,
    JobQueue,
    SyncStatus,
    Track,
    TrackPurpose,
    TrackType,
    AiModel,
    AiProvider,
    AssetEmbedding,
    Library,
    LibraryEmbeddingSpace,
    LibraryEmbeddingSpaceStatus,
    Media,
    MediaType,
} from "@/db/schema";
import { db } from "@/global/db";
import { kv } from "@/global/kv";
import { secretBox } from "@/global/secrets";
import { s3, S3ObjectTooLargeError } from "@/global/s3";
import { Quality } from "@/lib/types";
import { processLibraryAi } from "@/features/ai/actions";
import { clearModelBindings, getLibraryBindings, getRolesUsingModel, saveLibraryBindings } from "@/features/ai/bindings";
import { EMBEDDING_ROLE_FOR } from "@/features/ai/embedding-spaces";
import { getLibraryAiStatus } from "@/features/ai/status";
import { batchDeleteMedia } from "@/features/media/lifecycle";
import { createRedisRateLimitStore } from "@/features/ai/rate-limit";
import { HybridSearchService } from "@/features/ai/search";
import { AiService } from "@/features/ai/service";
import { coverPipeline } from "@/features/media/cover-pipeline";
import { markChanged, requestScan, requeue } from "@/infra/queue/changes";
import { pipelineHandlers } from "@/infra/queue/handlers";
import { Aspect, queueName } from "@/infra/queue/pipelines";
import { pipelineStatus } from "@/infra/queue/status";
import type { SubjectPipelineHandler } from "@/infra/queue/types";
import { QueueWorker } from "@/infra/queue/worker";

/**
 * Exercises the AI pipelines on the reconcile queue against a real PostgreSQL with pgvector and Redis: search
 * documents, batched vectors, vector search and space switching. Provider HTTP calls are answered by a fake
 * DashScope. Run with RUN_AI_DB_TESTS=1 and DB_URL / REDIS_URL pointing at disposable instances; the queue worker
 * claims every due row of the database.
 */
const databaseTest = process.env.RUN_AI_DB_TESTS === "1" ? test : test.skip;

const ownerId = crypto.randomUUID();
const libraryId = crypto.randomUUID();
const mediaIds = { cat: crypto.randomUUID(), dog: crypto.randomUUID(), car: crypto.randomUUID() };
let providerId = "";
/** Model names are unique per provider, so the 1024-dimension model sits on a second provider. */
let otherProviderId = "";
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
/**
 * Requests with a text containing this fail with `rejectedStatus`: by default a 413, like a provider refusing an input it
 * cannot take, which only the input can be blamed for.
 */
let rejectedText: string | null = null;
let rejectedStatus = 413;
const originalFetch = globalThis.fetch;

function fakeDashScope() {
    globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.url.startsWith("https://rerank.test/")) return fakeRerank(request);
        if (!request.url.includes("multimodal-embedding")) return originalFetch(input, init);
        const body = (await request.json()) as { input: { contents: Array<{ text?: string }> }; parameters?: { dimension?: number } };
        const dimension = body.parameters?.dimension ?? 1024;
        requests.push({ contents: body.input.contents, dimension });
        if (rejectedText !== null && body.input.contents.some((content) => content.text?.includes(rejectedText!))) {
            return new Response(JSON.stringify({ message: "bad input" }), {
                status: rejectedStatus,
                headers: { "content-type": "application/json" },
            });
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
    if (rerankFails)
        return new Response(JSON.stringify({ message: "unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    const body = (await request.json()) as { documents: string[] };
    const results = body.documents.map((document, index) => ({ index, relevance_score: document.includes("dog") ? 0.9 : 0.1 }));
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
}

/** Runs the queue worker until a library has no queued work left. */
async function drain(library: string, concurrency?: number) {
    const worker = new QueueWorker(pipelineHandlers, { concurrency, pollIntervalMs: 50, patrolIntervalMs: 0 });
    worker.start();
    try {
        const deadline = Date.now() + 20_000;
        while ((await db.$count(JobQueue, eq(JobQueue.library_id, library))) > 0) {
            if (Date.now() > deadline) throw new Error("The worker did not drain the library in time");
            await Bun.sleep(50);
        }
    } finally {
        await worker.drain();
    }
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

const statusOf = async (status: LibraryEmbeddingSpaceStatus) => (await spaces()).find((space) => space.status === status)?.space_id;

const library = { id: libraryId, owner_id: ownerId };

describe("AI embedding pipelines (PostgreSQL + Redis)", () => {
    beforeAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
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
        const [provider, otherProvider] = await db
            .insert(AiProvider)
            .values(
                ["Fake DashScope", "Fake DashScope 2"].map((name) => ({
                    owner_id: ownerId,
                    template_id: "dashscope-native",
                    name,
                    base_url: "https://dashscope.aliyuncs.com",
                    api_key_ciphertext: secretBox.encrypt("test-key"),
                })),
            )
            .returning();
        providerId = provider!.id;
        otherProviderId = otherProvider!.id;
        const [a, b] = await db
            .insert(AiModel)
            .values([
                {
                    provider_id: otherProviderId,
                    name: "qwen3-vl-embedding",
                    display_name: "Qwen3-VL Embedding",
                    category: "embedding",
                    capabilities: capabilities(1024),
                },
                {
                    provider_id: providerId,
                    name: "qwen3-vl-embedding",
                    display_name: "Qwen3-VL Embedding",
                    category: "embedding",
                    capabilities: capabilities(768),
                },
            ])
            .returning();
        modelA = a!.id;
        modelB = b!.id;
    });

    afterAll(async () => {
        globalThis.fetch = originalFetch;
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));
        await db.delete(AssetEmbedding).where(eq(AssetEmbedding.library_id, libraryId));
        await db.delete(AssetSearchDocument).where(eq(AssetSearchDocument.library_id, libraryId));
        await db.delete(LibraryEmbeddingSpace).where(eq(LibraryEmbeddingSpace.library_id, libraryId));
        await db.delete(Media).where(inArray(Media.id, Object.values(mediaIds)));
        await db.delete(AiModel).where(inArray(AiModel.provider_id, [providerId, otherProviderId]));
        await db.delete(AiProvider).where(inArray(AiProvider.id, [providerId, otherProviderId]));
        await db.delete(Library).where(eq(Library.id, libraryId));
    });

    databaseTest("indexes the library, embeds its documents and searches them through the vector index", async () => {
        await saveLibraryBindings(library, { textEmbedding: { modelId: modelA } });
        expect(await statusOf(LibraryEmbeddingSpaceStatus.ACTIVE)).toBe("qwen3-vl-embedding:1024:plain");

        await processLibraryAi(libraryId);
        await drain(libraryId);
        const documents = await db.select().from(AssetSearchDocument).where(eq(AssetSearchDocument.library_id, libraryId));
        expect(documents).toHaveLength(3);
        const rows = await rowsIn("qwen3-vl-embedding:1024:plain");
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.embedding?.length === 1024 && row.last_error === null)).toBe(true);
        // Several media share a request whenever they are due together.
        expect(requests.reduce((sum, request) => sum + request.contents.length, 0)).toBe(3);

        // A scan of an unchanged library finds nothing to do.
        const requestsBefore = requests.length;
        await processLibraryAi(libraryId);
        await drain(libraryId);
        expect(requests.length).toBe(requestsBefore);

        const service = await AiService.forLibrary(libraryId, "interactive");
        const query = await service!.embedQuery("textEmbedding", "cat");
        const results = await HybridSearchService.vectorSearch(query, EMBEDDING_ROLE_FOR.textEmbedding, 0.5, libraryId, 10, {
            library_id: libraryId,
            keyword: "cat",
        });
        expect(results.map((result) => result.id)).toEqual([mediaIds.cat]);
    });

    databaseTest("builds a new space beside the active one and promotes it once its queue drains", async () => {
        await saveLibraryBindings(library, { textEmbedding: { modelId: modelB } });
        expect(await statusOf(LibraryEmbeddingSpaceStatus.BUILDING)).toBe("qwen3-vl-embedding:768:plain");
        const service = await AiService.forLibrary(libraryId);
        expect(service!.textEmbedding.active?.spaceId).toBe("qwen3-vl-embedding:1024:plain");
        expect(service!.textEmbedding.building?.spaceId).toBe("qwen3-vl-embedding:768:plain");

        await drain(libraryId);
        expect(await rowsIn("qwen3-vl-embedding:768:plain")).toHaveLength(3);
        // The replaced space is retired, not dropped: its vectors stay for switching back.
        expect(await statusOf(LibraryEmbeddingSpaceStatus.ACTIVE)).toBe("qwen3-vl-embedding:768:plain");
        expect(await statusOf(LibraryEmbeddingSpaceStatus.RETIRED)).toBe("qwen3-vl-embedding:1024:plain");
        expect(await rowsIn("qwen3-vl-embedding:1024:plain")).toHaveLength(3);
        expect((await AiService.forLibrary(libraryId))!.textEmbedding.active?.spaceId).toBe("qwen3-vl-embedding:768:plain");
    });

    databaseTest("switches back to a retired space without embedding again", async () => {
        const requestsBefore = requests.length;
        await saveLibraryBindings(library, { textEmbedding: { modelId: modelA } });
        await drain(libraryId);
        expect(requests.length).toBe(requestsBefore);
        expect(await statusOf(LibraryEmbeddingSpaceStatus.ACTIVE)).toBe("qwen3-vl-embedding:1024:plain");
        expect(await statusOf(LibraryEmbeddingSpaceStatus.RETIRED)).toBe("qwen3-vl-embedding:768:plain");
    });

    /** Renames all three media in one change. */
    const retitle = (suffix: string) =>
        db.transaction(async (tx) => {
            for (const [animal, id] of Object.entries(mediaIds)) {
                await tx
                    .update(Media)
                    .set({ title: `${animal}${suffix}` })
                    .where(eq(Media.id, id));
            }
            await markChanged(tx, Aspect.MEDIA_META, Object.values(mediaIds));
        });

    databaseTest("finds the input a provider rejects in a batch and embeds the others", async () => {
        const spaceId = "qwen3-vl-embedding:1024:plain";
        const before = await rowsIn(spaceId);
        const hashOf = (rows: typeof before, id: string) => rows.find((row) => row.entity_id === id)!.content_hash;
        const requestsBefore = requests.length;

        rejectedText = "dog edited";
        await retitle(" edited");
        // One at a time, every search document is ready before the first text run, so they share a request.
        await drain(libraryId, 1);
        rejectedText = null;

        expect(requests[requestsBefore]?.contents).toHaveLength(3);
        const after = await rowsIn(spaceId);
        const dog = after.find((row) => row.entity_id === mediaIds.dog)!;
        expect(dog).toMatchObject({ content_hash: hashOf(before, mediaIds.dog), error_kind: "UNSUPPORTED" });
        for (const id of [mediaIds.cat, mediaIds.car]) {
            expect(hashOf(after, id)).not.toBe(hashOf(before, id));
            expect(after.find((row) => row.entity_id === id)).toMatchObject({ last_error: null, error_input_hash: null });
        }

        await retitle("");
        await drain(libraryId);
        const restored = await rowsIn(spaceId);
        for (const id of Object.values(mediaIds)) expect(hashOf(restored, id)).toBe(hashOf(before, id));
        expect(restored.every((row) => row.last_error === null)).toBe(true);
    });

    databaseTest("a 400 in a batch finds the input it is about but retries it, as a bad configuration answers the same", async () => {
        const spaceId = "qwen3-vl-embedding:1024:plain";
        const before = await rowsIn(spaceId);
        const hashOf = (rows: typeof before, id: string) => rows.find((row) => row.entity_id === id)!.content_hash;
        const textQueue = queueName("ai.text", (await spaces()).find((row) => row.space_id === spaceId)!.id);
        const dogRow = and(eq(JobQueue.pipeline, textQueue), eq(JobQueue.subject_id, mediaIds.dog));

        rejectedText = "dog edited";
        rejectedStatus = 400;
        const worker = new QueueWorker(pipelineHandlers, { concurrency: 1, pollIntervalMs: 50, patrolIntervalMs: 0 });
        try {
            await retitle(" edited");
            worker.start();
            const deadline = Date.now() + 20_000;
            for (;;) {
                const [row] = await db.select().from(JobQueue).where(dogRow);
                if (row && row.attempts > 0 && row.lease_token === null) break;
                if (Date.now() > deadline) throw new Error("The dog was never retried");
                await Bun.sleep(50);
            }
        } finally {
            await worker.drain();
            rejectedText = null;
            rejectedStatus = 413;
        }

        // The others got their vectors; the dog waits for its next attempt with no failure recorded yet.
        const after = await rowsIn(spaceId);
        for (const id of [mediaIds.cat, mediaIds.car]) expect(hashOf(after, id)).not.toBe(hashOf(before, id));
        expect(after.find((row) => row.entity_id === mediaIds.dog)).toMatchObject({
            content_hash: hashOf(before, mediaIds.dog),
            last_error: null,
        });

        await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));
        await retitle("");
        await drain(libraryId);
    });

    databaseTest("a scan finds a search document that no longer matches its source", async () => {
        const spaceId = "qwen3-vl-embedding:1024:plain";
        const hashOfCat = async () => (await rowsIn(spaceId)).find((row) => row.entity_id === mediaIds.cat)!.content_hash;
        const before = await hashOfCat();

        // A change no writer reported.
        await db.update(Media).set({ title: "cat renamed" }).where(eq(Media.id, mediaIds.cat));
        const page = await pipelineHandlers["ai.index"].scanPage(libraryId, null, 100, null);
        expect(page.subjectIds).toEqual([mediaIds.cat]);

        await requestScan(db, "ai.index", [libraryId]);
        await drain(libraryId);
        expect(await hashOfCat()).not.toBe(before);

        await retitle("");
        await drain(libraryId);
        expect(await hashOfCat()).toBe(before);
    });

    databaseTest("the end of a cover run wakes what waited for the cover, whether it stored one or not", async () => {
        const describe = spyOn(pipelineHandlers["ai.describe"] as SubjectPipelineHandler, "reconcile");
        try {
            // Nothing to render: this media has no content to make a cover from.
            await requeue(db, ["cover"], [mediaIds.cat]);
            await drain(libraryId);
            expect(describe).toHaveBeenCalledTimes(1);

            await db.transaction((tx) =>
                coverPipeline.recordFailure(tx, {
                    subjectId: mediaIds.cat,
                    space: null,
                    error: "cannot render",
                    errorKind: null,
                }),
            );
            await drain(libraryId);
            expect(describe).toHaveBeenCalledTimes(2);
        } finally {
            describe.mockRestore();
        }
    });

    databaseTest("the status shows how long work has waited and how long its provider is blocked", async () => {
        const store = createRedisRateLimitStore(kv);
        const statusOfText = async () =>
            (await pipelineStatus([libraryId])).get(libraryId)!.find((status) => status.pipeline === "ai.text")!;
        expect(await statusOfText()).toMatchObject({ queued: 0, oldestSeconds: 0, blockedSeconds: 0 });

        // A blocked provider says nothing about a pipeline that has no work for it.
        await store.coolDown(otherProviderId, 60_000);
        expect((await statusOfText()).blockedSeconds).toBe(0);

        await requeue(db, ["ai.text"], [mediaIds.cat]);
        await db
            .update(JobQueue)
            .set({ enqueued_at: sql`now() - interval '10 minutes'` })
            .where(eq(JobQueue.library_id, libraryId));
        const status = await statusOfText();
        expect(status.queued).toBe(1);
        expect(status.oldestSeconds).toBeGreaterThanOrEqual(600);
        expect(status.blockedSeconds).toBeGreaterThan(50);
        expect(status.blockedSeconds).toBeLessThanOrEqual(60);

        await store.reset(otherProviderId);
        await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));
    });

    databaseTest("records a rejected input, keeps the previous vector, and defers throttled work without counting attempts", async () => {
        const spaceId = "qwen3-vl-embedding:1024:plain";
        const vectorOf = async (mediaId: string) => (await rowsIn(spaceId)).find((row) => row.entity_id === mediaId)!;
        const previousHash = (await vectorOf(mediaIds.dog)).content_hash;

        // An edit of the title changes the search document, which queues the media for its vector.
        rejectedText = " v2";
        await db.transaction(async (tx) => {
            await tx.update(Media).set({ title: "dog v2" }).where(eq(Media.id, mediaIds.dog));
            await markChanged(tx, Aspect.MEDIA_META, [mediaIds.dog]);
        });
        await drain(libraryId);
        const failed = await vectorOf(mediaIds.dog);
        expect(failed).toMatchObject({ content_hash: previousHash, error_kind: "UNSUPPORTED" });
        expect(failed.embedding).not.toBeNull();
        expect(failed.error_input_hash).not.toBe(previousHash);

        // Settings show the provider's error next to the failed count, and the item stays covered by its old vector.
        const status = await getLibraryAiStatus(libraryId);
        const space = status.spaces.find((view) => view.spaceId === spaceId && view.status === LibraryEmbeddingSpaceStatus.ACTIVE);
        expect(space?.lastError?.message).toContain("bad input");
        expect(status.coverage).toMatchObject({ eligible: 3, covered: 3, missing: 0 });

        // A scan skips the failure while its input is unchanged; processing the library queues it again.
        const spaceRow = (await spaces()).find((row) => row.space_id === spaceId)!;
        const scanned = await pipelineHandlers["ai.text"].scanPage(libraryId, null, 100, spaceRow.id);
        expect(scanned.subjectIds).not.toContain(mediaIds.dog);
        const requestsBefore = requests.length;
        rejectedText = null;
        await processLibraryAi(libraryId);
        await drain(libraryId);
        expect(requests.length).toBe(requestsBefore + 1);
        const retried = await vectorOf(mediaIds.dog);
        expect(retried).toMatchObject({ last_error: null, error_input_hash: null });
        expect(retried.content_hash).not.toBe(previousHash);

        // A failure that is not about the input, once its attempts are used up, waits for processing the library too.
        const currentHash = retried.content_hash;
        const dogVector = eq(AssetEmbedding.id, retried.id);
        await db.update(AssetEmbedding).set({ content_hash: "an older input" }).where(dogVector);
        await db.transaction((tx) =>
            pipelineHandlers["ai.text"].recordFailure(tx, {
                subjectId: mediaIds.dog,
                space: spaceRow.id,
                error: "provider is down",
                errorKind: "TRANSIENT",
            }),
        );
        expect(await vectorOf(mediaIds.dog)).toMatchObject({ last_error: "provider is down", error_input_hash: currentHash });
        const rescanned = await pipelineHandlers["ai.text"].scanPage(libraryId, null, 100, spaceRow.id);
        expect(rescanned.subjectIds).not.toContain(mediaIds.dog);
        await db
            .update(AssetEmbedding)
            .set({ content_hash: currentHash, last_error: null, error_kind: null, error_input_hash: null })
            .where(dogVector);

        // At the provider's rate limit, the run is postponed without an attempt.
        await createRedisRateLimitStore(kv).coolDown(otherProviderId, 5_000);
        await db.transaction(async (tx) => {
            await tx.update(Media).set({ title: "dog v3" }).where(eq(Media.id, mediaIds.dog));
            await markChanged(tx, Aspect.MEDIA_META, [mediaIds.dog]);
        });
        const worker = new QueueWorker(pipelineHandlers, { pollIntervalMs: 50, patrolIntervalMs: 0 });
        worker.start();
        try {
            const deadline = Date.now() + 10_000;
            let row;
            do {
                if (Date.now() > deadline) throw new Error("The throttled row was not postponed in time");
                await Bun.sleep(50);
                [row] = await db
                    .select()
                    .from(JobQueue)
                    .where(and(eq(JobQueue.library_id, libraryId), sql`${JobQueue.pipeline} LIKE 'ai.text:%'`));
            } while (!row || row.lease_token !== null || row.available_at.epochMilliseconds <= Date.now());
            expect(row.attempts).toBe(0);
        } finally {
            await worker.drain();
        }
        await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));
    });

    databaseTest("blocks a provider that keeps failing and lets it through again when reset", async () => {
        const store = createRedisRateLimitStore(kv);
        const providerId = crypto.randomUUID();
        const limits = { maxConcurrency: 8, requestsPerMinute: null };
        const blocked = async () => {
            const leaseId = crypto.randomUUID();
            const wait = await store.acquire(providerId, limits, leaseId, 1_000);
            await store.release(providerId, leaseId);
            return wait;
        };

        for (let failure = 0; failure < 4; failure++) await store.reportFailure(providerId);
        expect(await blocked()).toBe(0);
        await store.reportSuccess(providerId);
        for (let failure = 0; failure < 4; failure++) await store.reportFailure(providerId);
        expect(await blocked()).toBe(0);

        expect(await store.reportFailure(providerId)).toBe(30_000);
        expect(await blocked()).toBeGreaterThan(20_000);
        expect(await store.blockedMs(providerId)).toBeGreaterThan(20_000);

        await store.reset(providerId);
        expect(await blocked()).toBe(0);
        expect(await store.blockedMs(providerId)).toBe(0);
        await store.reportFailure(providerId);
        expect(await blocked()).toBe(0);
    });

    databaseTest("leaves recycled media out of progress and removes AI data of deleted media", async () => {
        const spaceId = "qwen3-vl-embedding:1024:plain";
        await db
            .update(Media)
            .set({ recycle_time: sql`now()` })
            .where(eq(Media.id, mediaIds.car));
        expect((await getLibraryAiStatus(libraryId)).spaces.find((space) => space.spaceId === spaceId)?.ready).toBe(2);
        await db.update(Media).set({ recycle_time: null }).where(eq(Media.id, mediaIds.car));

        await batchDeleteMedia([mediaIds.cat]);
        const leftovers = await db.select({ id: AssetEmbedding.id }).from(AssetEmbedding).where(eq(AssetEmbedding.entity_id, mediaIds.cat));
        expect(leftovers).toHaveLength(0);
    });

    databaseTest("saves role bindings atomically and reads embedding roles from their spaces", async () => {
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
        // A new space queues a scan that fills it.
        expect(await db.$count(JobQueue, and(eq(JobQueue.library_id, libraryId), sql`${JobQueue.pipeline} LIKE 'scan:ai.image:%'`))).toBe(
            1,
        );
        await db.delete(JobQueue).where(eq(JobQueue.library_id, libraryId));

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
            .values({
                provider_id: rerankProviderId,
                name: "fake-reranker",
                display_name: "Fake Reranker",
                category: "rerank",
                capabilities: { maxInputTokens: 512 },
            })
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
        const first = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "a ", count: 2, page: 1 });
        expect(first.total).toBe(3);
        expect(first.list[0]?.id).toBe(media.dog);
        expect(first.list[0]?.matched_details?.rerank?.score).toBe(0.9);

        const second = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "a ", count: 2, page: 2 });
        expect(second.list).toHaveLength(1);
        expect(rerankCalls).toBe(1);
        expect(first.degraded).toEqual([]);
    });

    databaseTest("reports a failing reranker and an unusable model as degraded channels", async () => {
        rerankFails = true;
        try {
            const result = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "dog" });
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
        const unresolved = await HybridSearchService.search({ library_id: rerankLibraryId, keyword: "cat" });
        expect(unresolved.list.map((item) => item.id)).toEqual([media.cat]);
        expect(unresolved.degraded).toEqual([{ channel: "rerank", reason: "CONFIGURATION" }]);
    });

    databaseTest("matches keyword queries term by term, in any order", async () => {
        const find = async (keyword: string) =>
            (await HybridSearchService.keywordSearch(keyword, rerankLibraryId, 10, { library_id: rerankLibraryId, keyword })).map(
                (item) => item.id,
            );

        // "dog" is in the title, "Media Title: a" only in the content: each term may match either.
        expect(await find("dog a")).toEqual([media.dog]);
        expect(await find("a dog")).toEqual([media.dog]);
        expect(await find("  dog  ")).toEqual([media.dog]);
        // Every term must match.
        expect(await find("dog cat")).toEqual([]);
        expect(await find("   ")).toEqual([]);
    });
});

describe("Multilingual keyword search (PostgreSQL)", () => {
    const keywordOwnerId = crypto.randomUUID();
    const keywordLibraryId = crypto.randomUUID();
    const docs = {
        redCar: { title: "photo", content: "一辆红色的跑车停在路边" },
        cyberpunk: { title: "赛博朋克2077截图", content: "游戏" },
        scattered: { title: "photo", content: "赛车，博物馆，朋友，克隆" },
        tokyo: { title: "東京タワーの夜景", content: "" },
        katakana: { title: "photo", content: "ｶﾀｶﾅのロゴ" },
        art: { title: "art", content: "modern art" },
        start: { title: "start", content: "start screen" },
        cars: { title: "photo", content: "two cars" },
        strasse: { title: "Straße in Berlin", content: "" },
        door: { title: "photo", content: "Die Tür ist offen" },
        frontDoor: { title: "photo", content: "Haustür aus Holz" },
        phone: { title: "photo", content: "ＩＰＨＯＮＥ１５ case" },
        percent: { title: "photo", content: "100% cotton" },
        thousand: { title: "photo", content: "1000 items" },
    };
    const ids = Object.fromEntries(Object.keys(docs).map((key) => [key, crypto.randomUUID()])) as Record<keyof typeof docs, string>;
    const find = async (keyword: string) =>
        (await HybridSearchService.keywordSearch(keyword, keywordLibraryId, 20, { library_id: keywordLibraryId, keyword })).map(
            (item) => item.id,
        );

    beforeAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.insert(Library).values({ id: keywordLibraryId, name: "Keyword search test", description: "", owner_id: keywordOwnerId });
        const entries = Object.entries(docs) as Array<[keyof typeof docs, { title: string; content: string }]>;
        await db.insert(Media).values(
            entries.map(([key, doc], index) => ({
                id: ids[key],
                library_id: keywordLibraryId,
                eid: `keyword-${ids[key]}`,
                title: doc.title,
                description: "",
                type: MediaType.IMAGE,
                sort_order: index,
            })),
        );
        await db.insert(AssetSearchDocument).values(
            entries.map(([key, doc]) => ({
                library_id: keywordLibraryId,
                entity_type: EntityType.MEDIA,
                entity_id: ids[key],
                source: "MANUAL",
                title: doc.title,
                content: doc.content,
                content_hash: key,
            })),
        );
    });

    afterAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.delete(AssetSearchDocument).where(eq(AssetSearchDocument.library_id, keywordLibraryId));
        await db.delete(Media).where(eq(Media.library_id, keywordLibraryId));
        await db.delete(Library).where(eq(Library.id, keywordLibraryId));
    });

    databaseTest("finds Chinese and Japanese words without spaces, but not scattered characters", async () => {
        expect(await find("红色跑车")).toEqual([ids.redCar]);
        expect(await find("赛博朋克")).toEqual([ids.cyberpunk]);
        expect(await find("東京タワーの夜景")).toEqual([ids.tokyo]);
        expect(await find("カタカナ")).toEqual([ids.katakana]);
    });

    databaseTest("ranks whole English and German words above substrings", async () => {
        expect(await find("art")).toEqual([ids.art, ids.start]);
        expect(await find("car")).toEqual([ids.cars]);
        expect(await find("Tür")).toEqual([ids.door, ids.frontDoor]);
    });

    databaseTest("folds case, ß and full-width forms on both sides, and keeps wildcards literal", async () => {
        expect(await find("STRASSE")).toEqual([ids.strasse]);
        expect(await find("straße")).toEqual([ids.strasse]);
        expect(await find("iphone15")).toEqual([ids.phone]);
        expect(await find("100％")).toEqual([ids.percent]);
    });
});

describe("AI description (PostgreSQL + Redis)", () => {
    const enrichOwnerId = crypto.randomUUID();
    const enrichLibraryId = crypto.randomUUID();
    const mediaId = crypto.randomUUID();
    const fileId = crypto.randomUUID();
    let enrichProviderId = "";

    beforeAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        const [provider] = await db
            .insert(AiProvider)
            .values({
                owner_id: enrichOwnerId,
                template_id: "custom-openai-compatible",
                name: "Fake vision model",
                base_url: "https://vision.test/v1",
            })
            .returning();
        enrichProviderId = provider!.id;
        const [model] = await db
            .insert(AiModel)
            .values({
                provider_id: enrichProviderId,
                name: "fake-vision",
                display_name: "Fake Vision",
                category: "generation",
                capabilities: {
                    contextWindow: 32_000,
                    inputModalities: ["text", "image"],
                    imageFormats: ["image/jpeg"],
                    structuredOutput: true,
                },
            })
            .returning();
        await db.insert(Library).values({
            id: enrichLibraryId,
            name: "AI description test",
            description: "",
            owner_id: enrichOwnerId,
            ai_bindings: { describe: { modelId: model!.id } },
        });
        await db.insert(Media).values({
            id: mediaId,
            library_id: enrichLibraryId,
            eid: `ai-enrich-${mediaId}`,
            title: "harbour at dusk",
            description: "",
            type: MediaType.IMAGE,
            sort_order: 0,
        });
        await db.insert(DbFile).values({
            id: fileId,
            hash: "huge-image",
            size: 80 * 1024 * 1024,
            mime_type: "image/jpeg",
            path: `ai-enrich/${fileId}.jpg`,
            bucket: "test",
        });
        await db.insert(Track).values({
            media_id: mediaId,
            file_id: fileId,
            type: TrackType.IMAGE,
            purpose: TrackPurpose.CONTENT,
            quality: Quality.HIGH,
            sync_status: SyncStatus.COMPLETED,
            variant_key: "original",
            is_primary: true,
        });
    });

    afterAll(async () => {
        if (process.env.RUN_AI_DB_TESTS !== "1") return;
        await db.delete(JobQueue).where(eq(JobQueue.library_id, enrichLibraryId));
        await db.delete(AssetAiMetadata).where(eq(AssetAiMetadata.library_id, enrichLibraryId));
        await db.delete(AssetSearchDocument).where(eq(AssetSearchDocument.library_id, enrichLibraryId));
        await db.delete(Track).where(eq(Track.media_id, mediaId));
        await db.delete(DbFile).where(eq(DbFile.id, fileId));
        await db.delete(Media).where(eq(Media.id, mediaId));
        await db.delete(Library).where(eq(Library.id, enrichLibraryId));
        await db.delete(AiModel).where(eq(AiModel.provider_id, enrichProviderId));
        await db.delete(AiProvider).where(eq(AiProvider.id, enrichProviderId));
    });

    databaseTest("indexes an item whose image cannot be read and records why it was not described", async () => {
        const read = spyOn(s3, "read").mockRejectedValue(new S3ObjectTooLargeError(80 * 1024 * 1024, 50 * 1024 * 1024));
        try {
            await processLibraryAi(enrichLibraryId);
            await drain(enrichLibraryId);
        } finally {
            read.mockRestore();
        }

        // Keyword search still finds it, and AI settings count it as an item that cannot be processed.
        const [document] = await db.select().from(AssetSearchDocument).where(eq(AssetSearchDocument.entity_id, mediaId));
        expect(document?.content).toContain("harbour at dusk");
        const [metadata] = await db.select().from(AssetAiMetadata).where(eq(AssetAiMetadata.entity_id, mediaId));
        expect(metadata).toMatchObject({ error_kind: "UNSUPPORTED", input_hash: null });
        expect(metadata?.last_error).toContain("byte limit");
        expect(metadata?.error_input_hash).not.toBeNull();

        // A scan leaves the failure alone while the image is unchanged; processing the library queues it again.
        expect((await pipelineHandlers["ai.describe"].scanPage(enrichLibraryId, null, 100, null)).subjectIds).toEqual([]);

        // So does a failure that is not about the image, once its attempts are used up.
        await db.transaction((tx) =>
            pipelineHandlers["ai.describe"].recordFailure(tx, {
                subjectId: mediaId,
                space: null,
                error: "provider is down",
                errorKind: "TRANSIENT",
            }),
        );
        expect((await pipelineHandlers["ai.describe"].scanPage(enrichLibraryId, null, 100, null)).subjectIds).toEqual([]);

        await processLibraryAi(enrichLibraryId);
        expect(await db.$count(JobQueue, and(eq(JobQueue.library_id, enrichLibraryId), eq(JobQueue.pipeline, "ai.describe")))).toBe(1);
    });
});
