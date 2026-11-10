import { and, eq, isNull } from "drizzle-orm";
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

/** Derives a post's sync status from its active media: failed if any failed, completed once all completed. */
export async function refreshPostSyncStatus(tx: Transaction, postId: string, now = Temporal.Now.instant()) {
    const medias = await tx
        .select({ id: Media.id, sync_status: Media.sync_status, last_error: Media.last_error })
        .from(Media)
        .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

    const failed = medias.find((media) => media.sync_status === SyncStatus.FAILED);
    const status = failed
        ? SyncStatus.FAILED
        : medias.every((media) => media.sync_status === SyncStatus.COMPLETED)
          ? SyncStatus.COMPLETED
          : SyncStatus.IN_PROGRESS;

    await tx
        .update(Post)
        .set({
            sync_status: status,
            last_error: failed ? `Media item ${failed.id} failed to process: ${failed.last_error ?? "unknown error"}` : null,
            update_time: now,
        })
        .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE)));
}
