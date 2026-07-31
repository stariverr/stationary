import { TaskRetryReason, type TaskHandler, type TaskUnitContext, type TaskResult, type TaskExecutionSummary } from "@/infra/jobs/types";
import { TaskService } from "@/services/task";
import { AsyncOutcomeCode, Post, SyncStatus, AsyncTaskUnitKind } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getErrorMessage } from "@/lib/utils/error";
import { isLockAcquisitionError } from "@/lib/utils/lock";

type SubTaskExecutor = (context: TaskUnitContext) => Promise<TaskResult | void>;

/**
 * Strategy map for subtask execution kinds within POST_PROCESS handler.
 */
const subTaskExecutors: Partial<Record<AsyncTaskUnitKind, SubTaskExecutor>> = {
    MEDIA_DOWNLOAD: async (context) => {
        context.signal.throwIfAborted();
        await TaskService.processMediaById(context.unit.subject_id, context.signal);
        context.signal.throwIfAborted();
        return { success: true };
    },
    AVATAR_DOWNLOAD: async (context) => {
        const avatarUrl = context.unit.input_snapshot?.avatar_url;
        if (typeof avatarUrl !== "string" || !context.unit.subject_id) {
            return { success: true, skipped: true };
        }
        context.signal.throwIfAborted();
        await TaskService.processAvatar(context.unit.subject_id, avatarUrl, context.signal);
        context.signal.throwIfAborted();
        return { success: true };
    },
};

export const PostProcessHandler: TaskHandler = {
    async execute(context: TaskUnitContext): Promise<TaskResult> {
        const { unit } = context;
        const executor = subTaskExecutors[unit.kind];

        if (!executor) {
            return { success: false, retryable: false, error: `Unsupported unit kind '${unit.kind}' for POST_PROCESS handler` };
        }

        try {
            const result = await executor(context);
            return result ?? { success: true };
        } catch (error) {
            const lockContention = isLockAcquisitionError(error);
            return {
                success: false,
                error: getErrorMessage(error),
                retryable: true,
                retryReason: lockContention ? TaskRetryReason.LOCK_CONTENTION : undefined,
                outcomeCode: lockContention ? AsyncOutcomeCode.LOCKED_CONCURRENT_EXECUTION : AsyncOutcomeCode.UNHANDLED_EXCEPTION,
            };
        }
    },

    async finalizeTask(tx, task, summary: TaskExecutionSummary): Promise<void> {
        const postId = task.input_snapshot.post_id;
        if (typeof postId !== "string") return;

        const finalSyncStatus = summary.failedUnits > 0 ? SyncStatus.FAILED : SyncStatus.COMPLETED;
        const lastError = summary.failedUnits > 0 ? `${summary.failedUnits} unit(s) failed during post processing` : null;

        await tx
            .update(Post)
            .set({
                sync_status: finalSyncStatus,
                last_error: lastError,
            })
            .where(eq(Post.id, postId));
    },
};
