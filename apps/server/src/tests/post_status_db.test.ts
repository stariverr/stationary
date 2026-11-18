import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Library, Media, MediaType, Post, SyncStatus } from "@/db/schema";
import { refreshPostSyncStatus } from "@/features/media/composition";
import { db } from "@/global/db";

const databaseTest = process.env.RUN_POST_STATUS_DB_TESTS === "1" ? test : test.skip;

let libraryId = crypto.randomUUID();

afterEach(async () => {
    if (process.env.RUN_POST_STATUS_DB_TESTS !== "1") return;
    await db.delete(Media).where(eq(Media.library_id, libraryId));
    await db.delete(Post).where(eq(Post.library_id, libraryId));
    await db.delete(Library).where(eq(Library.id, libraryId));
    libraryId = crypto.randomUUID();
});

/** A post with one media per status, in sort order. */
async function postWith(statuses: SyncStatus[]) {
    await db.insert(Library).values({ id: libraryId, name: "test", description: "", owner_id: crypto.randomUUID() });
    const [post] = await db
        .insert(Post)
        .values({ eid: crypto.randomUUID(), title: "", description: "", media_count: statuses.length, library_id: libraryId })
        .returning({ id: Post.id });
    const media = await db
        .insert(Media)
        .values(
            statuses.map((sync_status, index) => ({
                eid: crypto.randomUUID(),
                post_id: post!.id,
                library_id: libraryId,
                sort_order: index,
                title: "",
                description: "",
                type: MediaType.IMAGE,
                sync_status,
                last_error: sync_status === SyncStatus.FAILED ? `error ${index}` : null,
            })),
        )
        .returning({ id: Media.id });
    // Returned in insert order, which is sort order.
    return { postId: post!.id, mediaIds: media.map((row) => row.id) };
}

async function postStatus(postId: string) {
    const [post] = await db.select({ status: Post.sync_status, error: Post.last_error }).from(Post).where(eq(Post.id, postId));
    return post!;
}

describe("refreshPostSyncStatus", () => {
    databaseTest("derives the status from the active media", async () => {
        const { postId, mediaIds } = await postWith([SyncStatus.COMPLETED, SyncStatus.FAILED, SyncStatus.FAILED]);

        await db.transaction((tx) => refreshPostSyncStatus(tx, [postId]));
        expect(await postStatus(postId)).toEqual({ status: SyncStatus.FAILED, error: `Media item ${mediaIds[1]} failed to process: error 1` });

        await db.update(Media).set({ recycle_time: Temporal.Now.instant() }).where(inArray(Media.id, mediaIds.slice(1)));
        await db.transaction((tx) => refreshPostSyncStatus(tx, [postId]));
        expect(await postStatus(postId)).toEqual({ status: SyncStatus.COMPLETED, error: null });
    });

    // Each transaction completes one media and refreshes the post before the other commits. Without the post lock both
    // read the other media as still in progress, and the post stays IN_PROGRESS.
    databaseTest("completes a post whose media complete at the same time", async () => {
        const { postId, mediaIds } = await postWith([SyncStatus.IN_PROGRESS, SyncStatus.IN_PROGRESS]);

        let arrive!: () => void;
        let arrived = 0;
        const bothWritten = new Promise<void>((resolve) => {
            arrive = () => {
                if (++arrived === 2) resolve();
            };
        });
        const complete = (mediaId: string) =>
            db.transaction(async (tx) => {
                await tx.update(Media).set({ sync_status: SyncStatus.COMPLETED }).where(eq(Media.id, mediaId));
                arrive();
                await bothWritten;
                await refreshPostSyncStatus(tx, [postId]);
            });
        await Promise.all(mediaIds.map(complete));

        expect(await postStatus(postId)).toEqual({ status: SyncStatus.COMPLETED, error: null });
    });
});
