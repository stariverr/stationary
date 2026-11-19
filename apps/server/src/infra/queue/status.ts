import { db } from "@/global/db";
import { requeue } from "@/infra/queue/changes";
import { pipelineHandlers } from "@/infra/queue/handlers";
import { PIPELINE_NAMES, parseQueueName, type PipelineName } from "@/infra/queue/pipelines";
import { countQueue } from "@/infra/queue/store";
import type { PipelineFailure } from "@/infra/queue/types";

export interface PipelineStatus {
    readonly pipeline: PipelineName;
    /** Subjects waiting or running. */
    readonly queued: number;
    readonly running: number;
    /** Subjects waiting to retry after a failed attempt. */
    readonly retrying: number;
    /** Subjects whose failure was recorded and still applies. */
    readonly failed: number;
    /** A library scan is queued or running, so `queued` may still grow. */
    readonly scanning: boolean;
    /** How long the oldest row, scans included, has been in the queue. A number that keeps growing means work is stuck. */
    readonly oldestSeconds: number;
    /** How long the pipeline's provider stays out of reach; 0 when it can be called or nothing is waiting for it. */
    readonly blockedSeconds: number;
}

/** A status page must not fail with the provider configuration it reports on. */
async function blockedSeconds(pipeline: PipelineName, libraryId: string): Promise<number> {
    const blockedMs = await pipelineHandlers[pipeline].blockedMs?.(libraryId).catch(() => 0);
    return Math.ceil((blockedMs ?? 0) / 1000);
}

/** The state of every pipeline in each library: queue counts plus the failures recorded on result rows. */
export async function pipelineStatus(libraryIds: readonly string[]): Promise<Map<string, PipelineStatus[]>> {
    const [queueRows, ...failures] = await Promise.all([
        countQueue(libraryIds),
        ...PIPELINE_NAMES.map((pipeline) => pipelineHandlers[pipeline].countFailures(libraryIds)),
    ]);
    const failuresByPipeline = new Map(PIPELINE_NAMES.map((pipeline, index) => [pipeline, failures[index]!]));

    const result = new Map<string, PipelineStatus[]>();
    for (const libraryId of libraryIds) {
        const statuses = PIPELINE_NAMES.map(async (pipeline) => {
            let queued = 0;
            let running = 0;
            let retrying = 0;
            let scanning = false;
            let oldestSeconds = 0;
            for (const row of queueRows) {
                const name = parseQueueName(row.pipeline);
                if (row.libraryId !== libraryId || name?.pipeline !== pipeline) continue;
                oldestSeconds = Math.max(oldestSeconds, row.oldestSeconds);
                if (name.scan) {
                    scanning = true;
                    continue;
                }
                queued += row.queued;
                running += row.running;
                retrying += row.retrying;
            }
            return {
                pipeline,
                queued,
                running,
                retrying,
                failed: failuresByPipeline.get(pipeline)!.get(libraryId) ?? 0,
                scanning,
                oldestSeconds,
                blockedSeconds: queued > 0 ? await blockedSeconds(pipeline, libraryId) : 0,
            };
        });
        result.set(libraryId, await Promise.all(statuses));
    }
    return result;
}

export interface FailureGroup {
    /** The kind its failures share; null for a pipeline that does not classify its failures. */
    readonly kind: string | null;
    readonly count: number;
    /** The most recent failures of the group, at most the limit asked for. */
    readonly failures: readonly PipelineFailure[];
}

/**
 * The current failures of a pipeline in a library, grouped by kind, the largest group first, so the page can tell what
 * most failures are and act on each kind (docs/failure_handling.zh-Hans.md, 9.2).
 */
export async function listFailureGroups(libraryId: string, pipeline: PipelineName, limit: number): Promise<FailureGroup[]> {
    const groups = new Map<string | null, PipelineFailure[]>();
    for (const failure of await pipelineHandlers[pipeline].listFailures(libraryId)) {
        const kind = failure.kind ?? null;
        groups.set(kind, [...(groups.get(kind) ?? []), failure]);
    }
    return [...groups]
        .map(([kind, failures]) => ({ kind, count: failures.length, failures: failures.slice(0, limit) }))
        .sort((a, b) => b.count - a.count);
}

/** Queues every current failure of a pipeline in a library that a run may get past again; returns how many. */
export async function retryFailures(libraryId: string, pipeline: PipelineName): Promise<number> {
    const handler = pipelineHandlers[pipeline];
    const failures = await handler.listFailures(libraryId);
    if (failures.length === 0) return 0;
    const subjectIds = failures.map((failure) => failure.subjectId);
    return db.transaction(async (tx) => {
        const retried = handler.resetFailures ? await handler.resetFailures(tx, subjectIds) : subjectIds;
        await requeue(tx, [pipeline], retried);
        return retried.length;
    });
}
