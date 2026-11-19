import { and, eq, inArray, or } from "drizzle-orm";
import { DeleteStatus, Media } from "@/db/schema";
import { lockPosts, refreshMediaSyncStatus } from "@/features/media/composition";
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

    // Retrying a post retries all of its media: their sources that failed for a retryable reason go back to PENDING and
    // download again. A source the platform refused or that cannot be read stays failed until it changes, so the count
    // is of the media that actually had something to retry.
    return db.transaction(async (tx) => {
        await lockPosts(tx, { postIds: input.post_ids, mediaIds: input.media_ids });
        const mediaFilters = [
            ...(input.post_ids?.length ? [inArray(Media.post_id, input.post_ids)] : []),
            ...(input.media_ids?.length ? [inArray(Media.id, input.media_ids)] : []),
        ];
        const media = await tx
            .select({ id: Media.id })
            .from(Media)
            .where(and(or(...mediaFilters), eq(Media.delete_status, DeleteStatus.ACTIVE)));

        const retried = await resetRetryableSources(
            tx,
            media.map((row) => row.id),
        );
        await refreshMediaSyncStatus(tx, retried);
        await markChanged(tx, Aspect.MEDIA_SOURCE, retried, Priority.CHANGE);
        return { retriedCount: retried.length };
    });
}
