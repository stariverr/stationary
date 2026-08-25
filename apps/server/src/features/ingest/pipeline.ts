import { db } from "@/global/db";
import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import { createIdempotencyKey } from "@/lib/utils/hash";
import { AsyncTaskType } from "@/db/schema";
import type { PostItemData } from "./schema";
import { saveIngestMetadata } from "./persistence";
import { buildPostProcessUnitSpecs } from "./post-process-units";

export interface IngestProcessResult {
    workflowRunId: string;
    postId: string;
    taskId: string | null;
    skipped: boolean;
}

export interface IngestPostCommand {
    postData: PostItemData;
    targetLibraryId: string;
    ownerId: string;
    workflowRunId?: string;
}

export const IngestPipeline = {
    /**
     * Process ingestion for a single Post item and enqueue post-processing jobs
     */
    async processPostIngest({
        postData,
        targetLibraryId,
        ownerId,
        workflowRunId: customWorkflowRunId,
    }: IngestPostCommand): Promise<IngestProcessResult> {
        const workflowRunId = customWorkflowRunId ?? crypto.randomUUID();

        const result = await db.transaction(async (tx) => {
            const saveResult = await saveIngestMetadata(postData, targetLibraryId, workflowRunId, tx);

            if (saveResult.skipUpdate) {
                return { saveResult, taskId: null };
            }

            const unitSpecs = buildPostProcessUnitSpecs({
                postId: saveResult.postId,
                mediaIds: saveResult.mediaIds,
                authorId: saveResult.authorId,
                avatarUrl: postData.author.avatar_file_url,
            });

            const task = await JobManager.enqueueTaskWithUnits(
                {
                    type: AsyncTaskType.POST_PROCESS,
                    libraryId: targetLibraryId,
                    ownerId,
                    inputSnapshot: {
                        post_id: saveResult.postId,
                        workflow_run_id: workflowRunId,
                    },
                    idempotencyKey: createIdempotencyKey("post_process", {
                        postId: saveResult.postId,
                        workflowRunId,
                    }),
                },
                unitSpecs,
                tx,
            );

            return { saveResult, taskId: task.id };
        });

        if (!result.saveResult.skipUpdate) {
            jobRunner.wake();
        }

        return {
            workflowRunId,
            postId: result.saveResult.postId,
            taskId: result.taskId,
            skipped: result.saveResult.skipUpdate,
        };
    },
};
