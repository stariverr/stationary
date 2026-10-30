import { and, inArray } from "drizzle-orm";
import { Author, LibraryEmbeddingSpace, LibraryEmbeddingSpaceStatus, Media } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { Priority } from "@/infra/queue/policy";
import { enqueue, isAnyOf, type EnqueueMode, type EnqueueRow } from "@/infra/queue/store";
import {
    PIPELINES,
    isLibraryAspect,
    pipelinesReading,
    queueName,
    scanQueueName,
    spaceRoleOf,
    type Aspect,
    type PipelineName,
    type SubjectKind,
} from "@/infra/queue/pipelines";

async function librariesOf(client: DbClient, kind: SubjectKind, ids: readonly string[]): Promise<Map<string, string>> {
    const table = kind === "media" ? Media : Author;
    const rows = await client.select({ id: table.id, libraryId: table.library_id }).from(table).where(isAnyOf(table.id, ids));
    return new Map(rows.map((row) => [row.id, row.libraryId]));
}

/**
 * The spaces `pipeline` runs in for each library: null for a pipeline that is not per space, otherwise every space of
 * its role the library writes (none when it writes no space of that role).
 */
async function spacesIn(
    client: DbClient,
    pipeline: PipelineName,
    libraryIds: readonly string[],
): Promise<Map<string, Array<string | null>>> {
    const role = spaceRoleOf(pipeline);
    if (!role) return new Map(libraryIds.map((libraryId) => [libraryId, [null]]));

    const spaces =
        libraryIds.length === 0
            ? []
            : await client
                  .select({ id: LibraryEmbeddingSpace.id, libraryId: LibraryEmbeddingSpace.library_id, role: LibraryEmbeddingSpace.role })
                  .from(LibraryEmbeddingSpace)
                  .where(
                      and(
                          inArray(LibraryEmbeddingSpace.library_id, [...libraryIds]),
                          inArray(LibraryEmbeddingSpace.status, [LibraryEmbeddingSpaceStatus.ACTIVE, LibraryEmbeddingSpaceStatus.BUILDING]),
                      ),
                  );
    const result = new Map<string, Array<string | null>>();
    for (const space of spaces) {
        if (space.role === role) result.set(space.libraryId, [...(result.get(space.libraryId) ?? []), space.id]);
    }
    return result;
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
    if (subjectIds.length === 0) return;
    const rows: EnqueueRow[] = [];
    const libraries = new Map<SubjectKind, Map<string, string>>();
    for (const pipeline of pipelines) {
        const kind = PIPELINES[pipeline].subject;
        let byId = libraries.get(kind);
        if (!byId) {
            byId = await librariesOf(client, kind, subjectIds);
            libraries.set(kind, byId);
        }
        const spaces = await spacesIn(client, pipeline, [...new Set(byId.values())]);
        for (const subjectId of subjectIds) {
            const libraryId = byId.get(subjectId);
            if (!libraryId) continue;
            for (const space of spaces.get(libraryId) ?? []) {
                rows.push({ pipeline: queueName(pipeline, space), subjectId, libraryId, priority: Priority.CHANGE });
            }
        }
    }
    await enqueue(client, rows);
}

/** Queues a scan of each library for a pipeline (in every space it writes, for a per-space pipeline). */
export async function requestScan(client: DbClient, pipeline: PipelineName, libraryIds: readonly string[], mode: EnqueueMode = "change") {
    const spaces = await spacesIn(client, pipeline, libraryIds);
    await enqueue(
        client,
        libraryIds.flatMap((libraryId) =>
            (spaces.get(libraryId) ?? []).map((space) => ({
                pipeline: scanQueueName(pipeline, space),
                subjectId: libraryId,
                libraryId,
                priority: Priority.CHANGE,
            })),
        ),
        mode,
    );
}
