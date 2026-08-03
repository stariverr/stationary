import {
    batchRetryFailedUnits,
    cancelTask,
    createTask,
    enqueueTaskWithUnits,
    onDeadLetter,
    pauseTask,
    resumeTask,
    retryFailedUnits,
    retrySingleFailedUnit,
} from "@/infra/jobs/store";

export const JobManager = {
    createTask,
    enqueueTaskWithUnits,
    pauseTask,
    resumeTask,
    cancelTask,
    retryFailedUnits,
    retrySingleFailedUnit,
    batchRetryFailedUnits,
    onDeadLetter,
};
