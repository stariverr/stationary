import type { DbClient } from "@/global/db";
import { markChanged, requeue } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";

/**
 * Media restored from the recycle bin re-enter the pipelines, which skip recycled media: downloads that were still
 * pending resume, previews are reconciled against the current cover and content, and AI results are checked against
 * the media's current data.
 */
export async function markRestored(client: DbClient, mediaIds: readonly string[]): Promise<void> {
    await markChanged(client, Aspect.MEDIA_SOURCE, mediaIds);
    await markChanged(client, Aspect.MEDIA_CONTENT, mediaIds);
    await requeue(client, ["ai.index", "ai.text"], mediaIds);
}
