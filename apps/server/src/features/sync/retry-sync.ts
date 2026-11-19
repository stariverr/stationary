import { and, eq, inArray, or } from "drizzle-orm";
import { DeleteStatus, Media, Post, SyncStatus } from "@/db/schema";
import { lockPosts, refreshPostSyncStatus } from "@/features/media/composition";
import { resetRetryableSources } from "@/features/media/source-rows";
import { canReachItems, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { Priority } from "@/infra/queue/policy";
import { RetrySyncError } from "./errors";
import type { RetrySyncInput } from "./schema";

export async function retrySync(input: RetrySyncInput, auth: LibraryAuth) {
    if (!(await canReachItems(input.post_ids ?? [], input.media_ids ?? [], auth))) {
        throw new RetrySyncError("One or more items were not found");
    }

    // Retrying a post retries all of its media; their downloads are queued again, with the sources that failed for a
    // retryable reason. A source the platform refused or that cannot be read fails the media again until it changes.
    return db.transaction(async (tx) => {
        const postIds = await lockPosts(tx, { postIds: input.post_ids, mediaIds: input.media_ids });
        let retriedCount = 0;
        if (input.post_ids?.length) {
            const posts = await tx.select({ id: Post.id }).from(Post).where(inArray(Post.id, input.post_ids));
            retriedCount += posts.length;
        }

        const mediaFilters = [
            ...(input.post_ids?.length ? [inArray(Media.post_id, input.post_ids)] : []),
            ...(input.media_ids?.length ? [inArray(Media.id, input.media_ids)] : []),
        ];
        if (mediaFilters.length === 0) return { retriedCount };

        const media = await tx
            .update(Media)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(and(or(...mediaFilters), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .returning({ id: Media.id });
        if (input.media_ids?.length) retriedCount += media.filter((row) => input.media_ids!.includes(row.id)).length;
        await refreshPostSyncStatus(tx, postIds);

        const mediaIds = media.map((row) => row.id);
        if (mediaIds.length === 0) return { retriedCount };
        await resetRetryableSources(tx, mediaIds);
        await markChanged(tx, Aspect.MEDIA_SOURCE, mediaIds, Priority.CHANGE);
        return { retriedCount };
    });
}
