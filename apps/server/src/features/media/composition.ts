import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { DbClient, Transaction } from "@/global/db";
import { DeleteStatus, Media, MediaType, Post, SyncStatus } from "@/db/schema";
import { compositionError, kindOfState, loadOriginalStates } from "./originals";

/**
 * Why a media whose sources have all been tried is not complete: an original that failed, or originals that do not
 * make up the media (section 4). Null when it is complete.
 */
export async function getMediaCompletionError(client: DbClient, media: { id: string; type: MediaType }): Promise<string | null> {
    const states = (await loadOriginalStates(client, [media.id])).get(media.id) ?? [];
    const failed = states.find((state) => state.original.status === SyncStatus.FAILED);
    if (failed) return failed.original.last_error ?? "An original failed to download";
    const kinds = states.map(kindOfState);
    if (kinds.some((kind) => kind === null)) return "An original is not downloaded and probed";
    return compositionError(media.type, kinds as NonNullable<(typeof kinds)[number]>[]);
}

/**
 * Locks the posts `postIds` name and the posts `mediaIds` belong to, in id order, and returns their ids.
 *
 * Every transaction that changes which active media a post has, or the sync status of a media in a post, locks the
 * post with this before it writes the media, so posts are always locked before media and in one order. Changing a
 * media's post also needs the post's lock (bind, unbind, recycle), so once the posts are locked the media stay in them
 * until the transaction ends. A media that joined a post between the read and the lock is picked up by reading again.
 */
export async function lockPosts(tx: Transaction, { postIds = [], mediaIds = [] }: { postIds?: readonly string[]; mediaIds?: readonly string[] }) {
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
 * Derives the sync status of posts from their active media: failed if any failed, completed once all completed (or
 * there are none), in progress otherwise. The only code that writes a post's `sync_status` and `last_error`; call it
 * in every transaction that changes either input, after lockPosts and the media writes.
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
        .select({ id: Media.id, post_id: Media.post_id, sync_status: Media.sync_status, last_error: Media.last_error })
        .from(Media)
        .where(and(inArray(Media.post_id, ids), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .orderBy(asc(Media.sort_order), asc(Media.id));

    for (const postId of ids) {
        const ofPost = medias.filter((media) => media.post_id === postId);
        const failed = ofPost.find((media) => media.sync_status === SyncStatus.FAILED);
        const status = failed
            ? SyncStatus.FAILED
            : ofPost.every((media) => media.sync_status === SyncStatus.COMPLETED)
              ? SyncStatus.COMPLETED
              : SyncStatus.IN_PROGRESS;
        await tx
            .update(Post)
            .set({
                sync_status: status,
                last_error: failed ? `Media item ${failed.id} failed to process: ${failed.last_error ?? "unknown error"}` : null,
                update_time: now,
            })
            .where(eq(Post.id, postId));
    }
}
