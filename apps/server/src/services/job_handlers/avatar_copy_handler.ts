import { AsyncOutcomeCode } from "@/db/schema";
import { TaskRetryReason, type TaskHandler, type TaskUnitContext, type TaskResult } from "@/infra/jobs/types";
import { TaskService } from "@/services/task";
import { getErrorMessage } from "@/lib/utils/error";
import { isLockAcquisitionError } from "@/lib/utils/lock";

export const AvatarCopyHandler: TaskHandler = {
    async execute(context: TaskUnitContext): Promise<TaskResult> {
        const { unit } = context;
        const snapshot = unit.input_snapshot ?? {};
        const sourceAuthorId = snapshot.sourceAuthorId || unit.subject_id;
        const targetAuthorId = snapshot.targetAuthorId;

        if (typeof sourceAuthorId !== "string" || typeof targetAuthorId !== "string") {
            return { success: false, error: "Missing targetAuthorId in input_snapshot", retryable: false };
        }

        try {
            context.signal.throwIfAborted();
            await TaskService.copyAuthorAvatar(sourceAuthorId, targetAuthorId, context.signal);
            context.signal.throwIfAborted();
            return { success: true };
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
};
