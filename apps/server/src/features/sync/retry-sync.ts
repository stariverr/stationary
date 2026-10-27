import { and, eq, inArray, ne, or } from "drizzle-orm";
import { DeleteStatus, Media, Post, SyncStatus, Track } from "@/db/schema";
import { canReachItems, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { RetrySyncError } from "./errors";
import type { RetrySyncInput } from "./schema";

export async function retrySync(input: RetrySyncInput, auth: LibraryAuth) {
    if (!(await canReachItems(input.post_ids ?? [], input.media_ids ?? [], auth))) {
        throw new RetrySyncError("One or more items were not found");
    }

    // Retrying a post retries all of its media; their downloads are queued again, failed tracks included.
    return db.transaction(async (tx) => {
        let retriedCount = 0;
        if (input.post_ids?.length) {
            const posts = await tx
                .update(Post)
                .set({ sync_status: SyncStatus.PENDING, last_error: null })
                .where(inArray(Post.id, input.post_ids))
                .returning({ id: Post.id });
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

        const mediaIds = media.map((row) => row.id);
        if (mediaIds.length === 0) return { retriedCount };
        await tx
            .update(Track)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(
                and(
                    inArray(Track.media_id, mediaIds),
                    eq(Track.sync_status, SyncStatus.FAILED),
                    ne(Track.source_url, ""),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                ),
            );
        await markChanged(tx, Aspect.MEDIA_SOURCE, mediaIds);
        return { retriedCount };
    });
}
