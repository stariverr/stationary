import type { DbClient } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";

/**
 * Media restored from the recycle bin re-enter the pipelines, which skip recycled media: downloads that were still
 * pending resume, and covers are reconciled against the library's current configuration.
 */
export async function markRestored(client: DbClient, mediaIds: readonly string[]): Promise<void> {
    await markChanged(client, Aspect.MEDIA_SOURCE, mediaIds);
    await markChanged(client, Aspect.MEDIA_CONTENT, mediaIds);
}
