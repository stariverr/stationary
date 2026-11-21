import { startFilePurgeSchedule, stopFilePurgeSchedule } from "@/features/trash/purge-expired-files";
import { pipelineHandlers } from "@/infra/queue/handlers";
import { QueueWorker } from "@/infra/queue/worker";

export interface WorkerRuntime {
    stop: () => Promise<void>;
}

/**
 * Starts the background reconcile queue worker and expired-file purge schedule.
 * Shared by the unified server (`SERVER_ROLE=all`) and the standalone worker entrypoint.
 */
export function startWorkerRuntime(onTooManyStuckRuns: () => void): WorkerRuntime {
    const queueWorker = new QueueWorker(pipelineHandlers, {
        onTooManyStuckRuns,
    });
    queueWorker.start();
    startFilePurgeSchedule();

    return {
        stop: async () => {
            stopFilePurgeSchedule();
            await queueWorker.drain();
        },
    };
}
