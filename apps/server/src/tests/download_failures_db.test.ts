import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { Library, Media, MediaCover, MediaOriginal, MediaType, SourceErrorKind, SyncStatus } from "@/db/schema";
import { downloadPipeline } from "@/features/ingest/download-pipeline";
import { db } from "@/global/db";
import type { ReconcileContext } from "@/infra/queue/types";

/**
 * Download failure handling (docs/failure_handling.zh-Hans.md, 4 and 5) against a local HTTP server that answers with
 * the status in its path. Run with RUN_DOWNLOAD_DB_TESTS=1 and DB_URL pointing at a disposable instance.
 */
const databaseTest = process.env.RUN_DOWNLOAD_DB_TESTS === "1" ? test : test.skip;

const hits = new Map<string, number>();
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
    if (process.env.RUN_DOWNLOAD_DB_TESTS !== "1") return;
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            hits.set(path, (hits.get(path) ?? 0) + 1);
            return new Response("no", { status: Number(path.split("/")[1]) });
        },
    });
});

afterAll(() => server?.stop(true));

let libraryId = crypto.randomUUID();

afterEach(async () => {
    if (process.env.RUN_DOWNLOAD_DB_TESTS !== "1") return;
    const media = db.select({ id: Media.id }).from(Media).where(eq(Media.library_id, libraryId));
    for (const table of [MediaOriginal, MediaCover]) await db.delete(table).where(inArray(table.media_id, media));
    await db.delete(Media).where(eq(Media.library_id, libraryId));
    await db.delete(Library).where(eq(Library.id, libraryId));
    libraryId = crypto.randomUUID();
});

const url = (status: number, name = crypto.randomUUID()) => `http://127.0.0.1:${server!.port}/${status}/${name}`;

async function imageMedia(originalUrl: string, extra: { cover?: string } = {}) {
    const mediaId = crypto.randomUUID();
    await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() }).onConflictDoNothing();
    await db.insert(Media).values({ id: mediaId, library_id: libraryId, eid: `download-${mediaId}`, title: "", description: "", type: MediaType.IMAGE, sort_order: 0 });
    await db.insert(MediaOriginal).values({ media_id: mediaId, source_url: originalUrl, source_key: "image", status: SyncStatus.PENDING });
    if (extra.cover) await db.insert(MediaCover).values({ media_id: mediaId, source_url: extra.cover, source_key: "cover", status: SyncStatus.PENDING });
    return mediaId;
}

function reconcile(mediaId: string) {
    const ctx: ReconcileContext = { subjectId: mediaId, libraryId, space: null, signal: new AbortController().signal, fence: async () => {} };
    return downloadPipeline.reconcile(ctx);
}

const originalOf = async (mediaId: string) => (await db.select().from(MediaOriginal).where(eq(MediaOriginal.media_id, mediaId)))[0]!;
const coverOf = async (mediaId: string) => (await db.select().from(MediaCover).where(eq(MediaCover.media_id, mediaId)))[0]!;
const mediaOf = async (mediaId: string) => (await db.select().from(Media).where(eq(Media.id, mediaId)))[0]!;

describe("download failures", () => {
    databaseTest("source rows refuse an error that does not belong to their current URL", async () => {
        const mediaId = await imageMedia(url(404));
        const original = await originalOf(mediaId);
        const write = async (values: Partial<typeof MediaOriginal.$inferInsert>) => {
            await db.update(MediaOriginal).set(values).where(eq(MediaOriginal.id, original.id));
        };

        await expect(write({ status: SyncStatus.FAILED })).rejects.toThrow();
        await expect(write({ last_error: "gone" })).rejects.toThrow();
        await expect(write({ last_error: "gone", error_kind: SourceErrorKind.SOURCE_UNAVAILABLE, error_source_url: "https://elsewhere" })).rejects.toThrow();
        await write({ status: SyncStatus.FAILED, last_error: "gone", error_kind: SourceErrorKind.SOURCE_UNAVAILABLE, error_source_url: original.source_url });
        // A new URL has to clear the error of the old one with it.
        await expect(write({ source_url: url(200) })).rejects.toThrow();
    });

    databaseTest("a source that is gone fails at once, bound to its URL, and fails the media", async () => {
        const gone = url(404);
        const mediaId = await imageMedia(gone);

        expect(await reconcile(mediaId)).toEqual({ kind: "done" });

        expect(await originalOf(mediaId)).toMatchObject({
            status: SyncStatus.FAILED,
            error_kind: SourceErrorKind.SOURCE_UNAVAILABLE,
            error_source_url: gone,
        });
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.FAILED);
        expect((await downloadPipeline.scanPage(libraryId, null, 100, null)).subjectIds).toEqual([]);
    });

    databaseTest("a 403 is tried once more before the source fails", async () => {
        const forbidden = url(403);
        const mediaId = await imageMedia(forbidden);

        expect(await reconcile(mediaId)).toEqual({ kind: "done" });

        expect(hits.get(new URL(forbidden).pathname)).toBe(2);
        expect(await originalOf(mediaId)).toMatchObject({ status: SyncStatus.FAILED, error_kind: SourceErrorKind.SOURCE_UNAVAILABLE });
    }, 15_000);

    databaseTest("a server error keeps the source waiting with its error and retries the media", async () => {
        const broken = url(500);
        const mediaId = await imageMedia(broken);

        expect(await reconcile(mediaId)).toMatchObject({ kind: "retry", errorKind: SourceErrorKind.NETWORK });

        expect(await originalOf(mediaId)).toMatchObject({
            status: SyncStatus.PENDING,
            error_kind: SourceErrorKind.NETWORK,
            error_source_url: broken,
        });
        expect((await downloadPipeline.scanPage(libraryId, null, 100, null)).subjectIds).toEqual([mediaId]);
    }, 15_000);

    databaseTest("a final failure does not stop the other sources", async () => {
        const gone = url(404);
        const cover = url(410);
        const mediaId = await imageMedia(gone, { cover });

        expect(await reconcile(mediaId)).toEqual({ kind: "done" });

        expect(hits.get(new URL(gone).pathname)).toBe(1);
        expect(await coverOf(mediaId)).toMatchObject({ status: SyncStatus.FAILED, error_kind: SourceErrorKind.SOURCE_UNAVAILABLE, error_source_url: cover });
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.FAILED);
    });

    databaseTest("used-up attempts fail the sources, which keep their own error", async () => {
        const mediaId = await imageMedia(url(500), { cover: url(200) });
        await db
            .update(MediaOriginal)
            .set({ last_error: "503 from the CDN", error_kind: SourceErrorKind.NETWORK, error_source_url: sql`source_url` })
            .where(eq(MediaOriginal.media_id, mediaId));

        await db.transaction((tx) => downloadPipeline.recordFailure(tx, { subjectId: mediaId, space: null, error: "The run timed out", errorKind: null }));

        expect(await originalOf(mediaId)).toMatchObject({ status: SyncStatus.FAILED, last_error: "503 from the CDN", error_kind: SourceErrorKind.NETWORK });
        expect(await coverOf(mediaId)).toMatchObject({ status: SyncStatus.FAILED, last_error: "The run timed out", error_kind: SourceErrorKind.INTERNAL });
        expect((await mediaOf(mediaId)).sync_status).toBe(SyncStatus.FAILED);
    });

    databaseTest("retrying failures only runs media a retry can get past", async () => {
        const retryable = await imageMedia(url(500));
        const gone = await imageMedia(url(404));
        await db.transaction((tx) => downloadPipeline.recordFailure(tx, { subjectId: retryable, space: null, error: "503", errorKind: SourceErrorKind.NETWORK }));
        await reconcile(gone);

        const retried = await db.transaction((tx) => downloadPipeline.resetFailures!(tx, [retryable, gone]));

        expect(retried).toEqual([retryable]);
        expect(await originalOf(retryable)).toMatchObject({ status: SyncStatus.PENDING, last_error: null, error_kind: null });
        expect((await mediaOf(retryable)).sync_status).toBe(SyncStatus.PENDING);
        expect(await originalOf(gone)).toMatchObject({ status: SyncStatus.FAILED, error_kind: SourceErrorKind.SOURCE_UNAVAILABLE });
        expect((await mediaOf(gone)).sync_status).toBe(SyncStatus.FAILED);
    });
});
