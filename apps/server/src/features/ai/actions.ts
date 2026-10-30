import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { DeleteStatus, Media } from "@/db/schema";
import { canReachItems, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { requestScan, requeue } from "@/infra/queue/changes";
import type { PipelineName } from "@/infra/queue/pipelines";
import { retryFailures } from "@/infra/queue/status";
import { QueueAiError } from "./errors";
import type { QueueAiInput } from "./schema";

export const AI_PIPELINES = ["ai.describe", "ai.index", "ai.text", "ai.image"] as const satisfies readonly PipelineName[];

/**
 * Processes whatever AI search does not cover yet: recorded failures are queued again, and a scan of every AI pipeline
 * queues the media whose results are missing or out of date. Stored results are reused, so only missing work reaches a
 * provider.
 */
export async function processLibraryAi(libraryId: string): Promise<void> {
    for (const pipeline of AI_PIPELINES) await retryFailures(libraryId, pipeline);
    await db.transaction(async (tx) => {
        for (const pipeline of AI_PIPELINES) await requestScan(tx, pipeline, [libraryId]);
    });
}

/** Queues the given media, and the media of the given posts, for every AI pipeline. */
export async function queueMediaAi(input: QueueAiInput, auth: LibraryAuth): Promise<{ count: number }> {
    if (!(await canReachItems(input.post_ids ?? [], input.media_ids ?? [], auth))) {
        throw new QueueAiError("NOT_FOUND", "One or more items were not found");
    }

    const selectors = [
        ...(input.post_ids?.length ? [inArray(Media.post_id, input.post_ids)] : []),
        ...(input.media_ids?.length ? [inArray(Media.id, input.media_ids)] : []),
    ];
    if (selectors.length === 0) return { count: 0 };

    const mediaList = await db
        .select({ id: Media.id, libraryId: Media.library_id })
        .from(Media)
        .where(and(or(...selectors), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    if (input.media_ids?.length && input.media_ids.some((id) => !mediaList.some((media) => media.id === id))) {
        throw new QueueAiError("INVALID_PARAMETER", "One or more media items were not found or not active");
    }
    if (mediaList.length === 0) return { count: 0 };

    await db.transaction((tx) =>
        requeue(
            tx,
            AI_PIPELINES,
            mediaList.map((media) => media.id),
        ),
    );
    return { count: mediaList.length };
}
