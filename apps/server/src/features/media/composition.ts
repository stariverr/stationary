import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbClient, Transaction } from "@/global/db";
import { DeleteStatus, Media, MediaCaption, MediaCover, MediaOriginal, Post, SyncStatus } from "@/db/schema";

/**
 * The status that sums up parts (4.4): a part still syncing wins over a failed one, as it may yet complete; failed
 * comes next, and completed once every part completed (or there are none).
 */
function summarize(statuses: readonly SyncStatus[]): SyncStatus {
    for (const status of [SyncStatus.IN_PROGRESS, SyncStatus.PENDING, SyncStatus.FAILED]) {
        if (statuses.includes(status)) return status;
    }
    return SyncStatus.COMPLETED;
}

/**
 * Derives the sync status of media from their imported sources (docs/failure_handling.zh-Hans.md, 4.4), then of the
 * posts they belong to. The status is only a summary: the failure itself stays on the source row. The import declared
 * kinds that make up the media and each original was checked against its kind, so a media whose sources all completed
 * is complete. Uploads and embedded captions have no source URL and never hold a media back.
 * The only code that writes a media's `sync_status`; call it in every transaction that writes source rows, which locks
 * the posts first.
 */
export async function refreshMediaSyncStatus(tx: Transaction, mediaIds: readonly string[], now = Temporal.Now.instant()) {
    if (mediaIds.length === 0) return;
    const postIds = await lockPosts(tx, { mediaIds });
    const medias = await tx
        .select({ id: Media.id, sync_status: Media.sync_status })
        .from(Media)
        .where(and(inArray(Media.id, [...mediaIds]), eq(Media.delete_status, DeleteStatus.ACTIVE)));
    const ids = medias.map((media) => media.id);
    // One after another: a transaction runs on one connection.
    const sources = [];
    for (const table of [MediaOriginal, MediaCaption, MediaCover]) {
        sources.push(
            ...(await tx
                .select({ media_id: table.media_id, status: table.status })
                .from(table)
                .where(and(inArray(table.media_id, ids), isNotNull(table.source_url)))),
        );
    }

    for (const media of medias) {
        const status = summarize(sources.filter((source) => source.media_id === media.id).map((source) => source.status));
        if (status === media.sync_status) continue;
        await tx.update(Media).set({ sync_status: status, update_time: now }).where(eq(Media.id, media.id));
    }
    await refreshPostSyncStatus(tx, postIds, now);
}

/**
 * Locks the posts `postIds` name and the posts `mediaIds` belong to, in id order, and returns their ids.
 *
 * Every transaction that changes which active media a post has, or the sync status of a media in a post, locks the
 * post with this before it writes the media, so posts are always locked before media and in one order. Changing a
 * media's post also needs the post's lock (bind, unbind, recycle), so once the posts are locked the media stay in them
 * until the transaction ends. A media that joined a post between the read and the lock is picked up by reading again.
 */
export async function lockPosts(
    tx: Transaction,
    { postIds = [], mediaIds = [] }: { postIds?: readonly string[]; mediaIds?: readonly string[] },
) {
    const locked = new Set<string>();
    let wanted = new Set(postIds);
    for (;;) {
        if (mediaIds.length > 0) {
            const rows = await tx
                .selectDistinct({ post_id: Media.post_id })
                .from(Media)
                .where(and(inArray(Media.id, [...mediaIds]), isNotNull(Media.post_id)));
            for (const row of rows) wanted.add(row.post_id!);
        }
        const missing = [...wanted].filter((id) => !locked.has(id)).sort();
        if (missing.length === 0) return [...locked].sort();
        await tx.select({ id: Post.id }).from(Post).where(inArray(Post.id, missing)).orderBy(asc(Post.id)).for("update");
        for (const id of missing) locked.add(id);
        if (mediaIds.length === 0) return [...locked].sort();
        wanted = new Set(locked);
    }
}

/**
 * Derives the sync status of posts from their active media, by the same rule as a media from its sources
 * (summarize). The only code that writes a post's `sync_status`; call it in every
 * transaction that changes either input, after lockPosts and the media writes.
 *
 * It locks the posts again, which is free when the caller already holds them. The lock is what makes the result
 * right: two transactions that each complete one media of a post would otherwise both read the other media as
 * unfinished and leave the post IN_PROGRESS for good. With it, the second waits for the first, and its read, a new
 * statement under READ COMMITTED, sees the first one's media.
 *
 * A post in the trash keeps the status it had: its media went to the trash with it, so they would read as none.
 * Restoring the post refreshes it.
 */
export async function refreshPostSyncStatus(tx: Transaction, postIds: readonly string[], now = Temporal.Now.instant()) {
    const locked = await lockPosts(tx, { postIds });
    if (locked.length === 0) return;
    const live = await tx
        .select({ id: Post.id })
        .from(Post)
        .where(and(inArray(Post.id, locked), eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time)));
    const ids = live.map((post) => post.id).sort();
    if (ids.length === 0) return;
    const medias = await tx
        .select({ post_id: Media.post_id, sync_status: Media.sync_status })
        .from(Media)
        .where(and(inArray(Media.post_id, ids), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

    for (const postId of ids) {
        const status = summarize(medias.filter((media) => media.post_id === postId).map((media) => media.sync_status));
        await tx.update(Post).set({ sync_status: status, update_time: now }).where(eq(Post.id, postId));
    }
}
