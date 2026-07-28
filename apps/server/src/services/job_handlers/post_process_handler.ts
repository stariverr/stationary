import type { TaskHandler, TaskUnitContext, TaskResult, TaskExecutionSummary } from "@/infra/jobs/types";
import { TaskService } from "@/services/task";
import { Post, SyncStatus, AsyncTaskUnitKind } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getErrorMessage } from "@/lib/utils/error";

type SubTaskExecutor = (context: TaskUnitContext) => Promise<TaskResult | void>;

/**
 * Strategy map for subtask execution kinds within POST_PROCESS handler.
 */
const subTaskExecutors: Partial<Record<AsyncTaskUnitKind, SubTaskExecutor>> = {
    MEDIA_DOWNLOAD: async (context) => {
        context.signal.throwIfAborted();
        await TaskService.processMediaById(context.unit.subject_id);
        context.signal.throwIfAborted();
        return { success: true };
    },
    AVATAR_DOWNLOAD: async (context) => {
        const avatarUrl = context.unit.input_snapshot?.avatar_url;
        if (typeof avatarUrl !== "string" || !context.unit.subject_id) {
            return { success: true, skipped: true };
        }
        context.signal.throwIfAborted();
        await TaskService.processAvatar(context.unit.subject_id, avatarUrl);
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
            return {
                success: false,
                error: getErrorMessage(error),
                retryable: true,
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
