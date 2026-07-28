import type { TaskHandler, TaskUnitContext, TaskResult, TaskExecutionSummary } from "@/infra/jobs/types";
import { AiEnrichmentService } from "@/services/ai/enrich";
import { db } from "@/global/db";
import { Media, Post, AssetAiMetadata, ProcessingStatus, EntityType, DeleteStatus } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import { getErrorMessage } from "@/lib/utils/error";

export const AiEnrichHandler: TaskHandler = {
    async execute(context: TaskUnitContext): Promise<TaskResult> {
        context.signal.throwIfAborted();
        const mediaId = context.unit.subject_id;
        const mediaList = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        const media = mediaList[0];

        if (!media) {
            return { success: true, skipped: true };
        }

        let post = null;
        if (media.post_id) {
            const postList = await db
                .select()
                .from(Post)
                .where(and(eq(Post.id, media.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            post = postList[0] || null;
        }

        const postContext = post || {
            id: null,
            source: media.source,
            title: media.title,
            description: media.description,
            author_name: "",
        };

        try {
            context.signal.throwIfAborted();
            await AiEnrichmentService.enrichMediaItem(media, postContext);
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

    async finalizeTask(tx, task, summary: TaskExecutionSummary): Promise<void> {
        if (summary.failedUnits === 0) return;

        const inputMediaIds = task.input_snapshot.media_ids;
        const mediaIds = Array.isArray(inputMediaIds) ? inputMediaIds.filter((id): id is string => typeof id === "string") : [];
        if (mediaIds.length === 0) return;

        await tx
            .update(AssetAiMetadata)
            .set({
                processing_status: ProcessingStatus.FAILED,
                last_error: "AI enrichment task failed",
            })
            .where(
                and(
                    inArray(AssetAiMetadata.entity_id, mediaIds),
                    eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                    eq(AssetAiMetadata.processing_status, ProcessingStatus.PENDING),
                ),
            );
    },
};
