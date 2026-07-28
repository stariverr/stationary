import type { TaskHandler, TaskUnitContext, TaskResult } from "@/infra/jobs/types";
import { TaskService } from "@/services/task";
import { getErrorMessage } from "@/lib/utils/error";

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
            await TaskService.copyAuthorAvatar(sourceAuthorId, targetAuthorId);
            context.signal.throwIfAborted();
            return { success: true };
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error),
                retryable: true,
            };
        }
    },
};
