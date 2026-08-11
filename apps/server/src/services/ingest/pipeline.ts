import { db } from "@/global/db";
import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import { createIdempotencyKey } from "@/lib/utils/hash";
import { AsyncTaskType, AsyncTaskUnitKind, AsyncSubjectType } from "@/db/schema";
import type { DiscoveredUnitSpec } from "@/infra/jobs/types";
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

        const unitSpecs: DiscoveredUnitSpec[] = postData.media.map((m, idx) => ({
            unitKey: `media:${m.external_id || idx}`,
            kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
            subjectType: AsyncSubjectType.POST,
            subjectId: saveResult.postId,
            inputSnapshot: { post_id: saveResult.postId, media_index: idx },
        }));

        if (saveResult.authorId && postData.author.avatar_file_url) {
            unitSpecs.push({
                unitKey: `avatar:${saveResult.authorId}`,
                kind: AsyncTaskUnitKind.AVATAR_DOWNLOAD,
                subjectType: AsyncSubjectType.AUTHOR,
                subjectId: saveResult.authorId,
                inputSnapshot: { author_id: saveResult.authorId, avatar_url: postData.author.avatar_file_url },
            });
        }

        await JobManager.enqueueTaskWithUnits({
            type: AsyncTaskType.POST_PROCESS,
            libraryId: targetLibraryId,
            inputSnapshot: {
                post_id: saveResult.postId,
                workflow_run_id: workflowRunId,
            },
            idempotencyKey: createIdempotencyKey("POST_PROCESS", {
                postId: saveResult.postId,
                workflowRunId,
            }),
        }, unitSpecs);

        jobRunner.wake();

        return {
            workflowRunId,
            postId: saveResult.postId,
            skipped: false,
        };
    },
};
