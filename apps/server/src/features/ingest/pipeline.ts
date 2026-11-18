import { db } from "@/global/db";
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
    /** Saves one post's metadata and reports its media sources and metadata as changed, which queues their downloads and search documents. */
    async processPostIngest({
        postData,
        targetLibraryId,
        workflowRunId: customWorkflowRunId,
    }: IngestPostCommand): Promise<IngestProcessResult> {
        const workflowRunId = customWorkflowRunId ?? crypto.randomUUID();

        const saveResult = await db.transaction(async (tx) => {
            const saved = await saveIngestMetadata(postData, targetLibraryId, workflowRunId, tx);
            if (saved.skipUpdate) return saved;
            if (saved.mediaIds.length > 0) {
                await markChanged(tx, Aspect.MEDIA_SOURCE, saved.mediaIds);
                // The post's metadata describes its media in search.
                await markChanged(tx, Aspect.MEDIA_META, saved.mediaIds);
            }
            return saved;
        });

        return { workflowRunId, postId: saveResult.postId, skipped: saveResult.skipUpdate };
    },
};
