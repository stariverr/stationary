import { db } from "@/global/db";
import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import { createIdempotencyKey } from "@/lib/utils/hash";
import type { PostItemData } from "@/api/schemas/ingest";
import { saveIngestMetadata } from "./persistence";

export interface IngestProcessResult {
    workflowRunId: string;
    postId: string;
    skipped: boolean;
}

export const IngestPipeline = {
    /**
     * Process ingestion for a single Post item and enqueue post-processing jobs
     */
    async processPostIngest(postData: PostItemData, targetLibraryId: string, customWorkflowRunId?: string): Promise<IngestProcessResult> {
        const workflowRunId = customWorkflowRunId ?? crypto.randomUUID();

        const saveResult = await db.transaction(async (tx) => {
            return saveIngestMetadata(postData, targetLibraryId, workflowRunId, tx);
        });

        if (saveResult.skipUpdate) {
            return {
                workflowRunId,
                postId: saveResult.postId,
                skipped: true,
            };
        }

        // 1. Enqueue Avatar download job if needed
        if (saveResult.authorId && postData.author.avatar_file_url) {
            const avatarIdempotencyKey = createIdempotencyKey("AVATAR_DOWNLOAD", saveResult.authorId, postData.author.avatar_file_url);
            await JobManager.createJob(
                {
                    type: "AVATAR_DOWNLOAD",
                    library_id: targetLibraryId,
                    input_snapshot: {
                        author_id: saveResult.authorId,
                        url: postData.author.avatar_file_url,
                    },
                    idempotency_key: avatarIdempotencyKey,
                },
                [
                    {
                        kind: "AVATAR_DOWNLOAD",
                        subject_type: "AUTHOR",
                        subject_id: saveResult.authorId,
                        unit_key: "AVATAR:ORIGINAL",
                        input_snapshot: {
                            url: postData.author.avatar_file_url,
                        },
                    },
                ],
            );
        }

        // 2. Enqueue Media download / post-processing job
        const mediaIdempotencyKey = createIdempotencyKey("MEDIA_DOWNLOAD", saveResult.postId, workflowRunId);
        const masterTaskId = await JobManager.createJob(
            {
                type: "POST_PROCESS",
                library_id: targetLibraryId,
                input_snapshot: {
                    post_id: saveResult.postId,
                    workflow_run_id: workflowRunId,
                },
                idempotency_key: mediaIdempotencyKey,
            },
            [
                {
                    kind: "MEDIA_DOWNLOAD",
                    subject_type: "POST",
                    subject_id: saveResult.postId,
                    unit_key: `POST:${saveResult.postId}`,
                    input_snapshot: {
                        post_id: saveResult.postId,
                    },
                },
            ],
        );

        // Signal job runner to pick up task immediately
        jobRunner.kickoffTask(masterTaskId);

        return {
            workflowRunId,
            postId: saveResult.postId,
            skipped: false,
        };
    },
};
