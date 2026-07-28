import { cancelTask, createTask, enqueueTaskWithUnits, pauseTask, resumeTask, retryFailedUnits } from "@/infra/jobs/store";

export const JobManager = {
    createTask,
    enqueueTaskWithUnits,
    pauseTask,
    resumeTask,
    cancelTask,
    retryFailedUnits,
};