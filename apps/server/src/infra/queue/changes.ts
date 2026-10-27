import { inArray } from "drizzle-orm";
import { Author, Media } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { Priority } from "@/infra/queue/policy";
import { enqueue, type EnqueueMode, type EnqueueRow } from "@/infra/queue/store";
import {
    PIPELINES,
    isLibraryAspect,
    pipelinesReading,
    scanQueueName,
    type Aspect,
    type PipelineName,
    type SubjectKind,
} from "@/infra/queue/pipelines";

async function librariesOf(client: DbClient, kind: SubjectKind, ids: readonly string[]): Promise<Map<string, string>> {
    const table = kind === "media" ? Media : Author;
    const rows = await client
        .select({ id: table.id, libraryId: table.library_id })
        .from(table)
        .where(inArray(table.id, [...ids]));
    return new Map(rows.map((row) => [row.id, row.libraryId]));
}

/**
 * Reports that `aspect` changed for `ids` (subject ids, or library ids for `library.*` aspects). Call it inside the
 * transaction that made the change, so the follow-up work is queued exactly when the change commits.
 */
export async function markChanged(client: DbClient, aspect: Aspect, ids: readonly string[]): Promise<void> {
    const uniqueIds = [...new Set(ids)];
    const pipelines = pipelinesReading(aspect);
    if (uniqueIds.length === 0 || pipelines.length === 0) return;

    if (isLibraryAspect(aspect)) {
        for (const pipeline of pipelines) await requestScan(client, pipeline, uniqueIds);
        return;
    }

    await requeue(client, pipelines, uniqueIds);
}

/**
 * Queues subjects for specific pipelines without reporting a change, for when the user asks to redo or retry a
 * pipeline's own results (regenerate a cover, retry failures).
 */
export async function requeue(client: DbClient, pipelines: readonly PipelineName[], subjectIds: readonly string[]): Promise<void> {
    const rows: EnqueueRow[] = [];
    const libraries = new Map<SubjectKind, Map<string, string>>();
    for (const pipeline of pipelines) {
        const kind = PIPELINES[pipeline].subject;
        let byId = libraries.get(kind);
        if (!byId) {
            byId = await librariesOf(client, kind, subjectIds);
            libraries.set(kind, byId);
        }
        for (const subjectId of subjectIds) {
            const libraryId = byId.get(subjectId);
            if (libraryId) rows.push({ pipeline, subjectId, libraryId, priority: Priority.CHANGE });
        }
    }
    await enqueue(client, rows);
}

/** Queues a scan of each library for a pipeline. */
export async function requestScan(client: DbClient, pipeline: PipelineName, libraryIds: readonly string[], mode: EnqueueMode = "change") {
    await enqueue(
        client,
        libraryIds.map((libraryId) => ({ pipeline: scanQueueName(pipeline), subjectId: libraryId, libraryId, priority: Priority.CHANGE })),
        mode,
    );
}
