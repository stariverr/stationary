import { db } from "@/global/db";
import { requeue } from "@/infra/queue/changes";
import { pipelineHandlers } from "@/infra/queue/handlers";
import { PIPELINE_NAMES, parseQueueName, type PipelineName } from "@/infra/queue/pipelines";
import { countQueue } from "@/infra/queue/store";

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
        result.set(
            libraryId,
            PIPELINE_NAMES.map((pipeline) => {
                let queued = 0;
                let running = 0;
                let retrying = 0;
                let scanning = false;
                for (const row of queueRows) {
                    const name = parseQueueName(row.pipeline);
                    if (row.libraryId !== libraryId || name?.pipeline !== pipeline) continue;
                    if (name.scan) {
                        scanning = true;
                        continue;
                    }
                    queued += row.queued;
                    running += row.running;
                    retrying += row.retrying;
                }
                return { pipeline, queued, running, retrying, failed: failuresByPipeline.get(pipeline)!.get(libraryId) ?? 0, scanning };
            }),
        );
    }
    return result;
}

export function listFailures(libraryId: string, pipeline: PipelineName, limit: number) {
    return pipelineHandlers[pipeline].listFailures(libraryId, limit);
}

/** Queues every current failure of a pipeline in a library again; a run on unchanged input retries it. */
export async function retryFailures(libraryId: string, pipeline: PipelineName): Promise<number> {
    const failures = await pipelineHandlers[pipeline].listFailures(libraryId);
    if (failures.length === 0) return 0;
    await requeue(
        db,
        [pipeline],
        failures.map((failure) => failure.subjectId),
    );
    return failures.length;
}
