import { db } from "@/global/db";
import { refreshPostSyncStatus } from "@/features/media/composition";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { PostItemData } from "./schema";
import { saveIngestMetadata } from "./persistence";

export interface IngestProcessResult {
    workflowRunId: string;
    postId: string;
    skipped: boolean;
}

export interface IngestPostCommand {
    postData: PostItemData;
    targetLibraryId: string;
    workflowRunId?: string;
}

export const IngestPipeline = {
    /** Saves one post's metadata and reports its media sources as changed, which queues their downloads. */
    async processPostIngest({
        postData,
        targetLibraryId,
        workflowRunId: customWorkflowRunId,
    }: IngestPostCommand): Promise<IngestProcessResult> {
        const workflowRunId = customWorkflowRunId ?? crypto.randomUUID();

        const saveResult = await db.transaction(async (tx) => {
            const saved = await saveIngestMetadata(postData, targetLibraryId, workflowRunId, tx);
            if (saved.skipUpdate) return saved;
            if (saved.mediaIds.length > 0) await markChanged(tx, Aspect.MEDIA_SOURCE, saved.mediaIds);
            else await refreshPostSyncStatus(tx, saved.postId, Temporal.Now.instant());
            return saved;
        });

        return { workflowRunId, postId: saveResult.postId, skipped: saveResult.skipUpdate };
    },
};
