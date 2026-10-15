import type { TaskHandler, TaskUnitContext, TaskResult, TaskExecutionSummary } from "@/infra/jobs/types";
import { AiEnrichmentService } from "@/features/ai/enrich";
import { CoverNotReadyError } from "@/features/ai/image-source";
import { db } from "@/global/db";
import { Media, Post, AssetAiMetadata, AsyncSubjectType, AsyncTaskUnitKind, ProcessingStatus, EntityType, DeleteStatus } from "@/db/schema";
import { eq, and, asc, gt, inArray, isNull } from "drizzle-orm";
import { TaskRetryReason } from "@/infra/jobs/types";
import { classifyAiError, getSafeAiErrorMessage } from "@/features/ai/errors";

export const AiEnrichHandler: TaskHandler = {
    /**
     * Library-wide runs (`input_snapshot.scope = "library"`, e.g. embedding space backfills) discover
     * their media page by page. Explicit runs are enqueued with their units already built.
     */
    async discoverUnits(task, discoveryCursor, batchSize) {
        if (!task.library_id || task.input_snapshot?.scope !== "library") {
            return { units: [], nextCursor: null, hasMore: false };
        }
        const lastMediaId = typeof discoveryCursor?.lastMediaId === "string" ? discoveryCursor.lastMediaId : null;
        const mediaBatch = await db
            .select({ id: Media.id })
            .from(Media)
            .where(
                and(
                    eq(Media.library_id, task.library_id),
                    eq(Media.delete_status, DeleteStatus.ACTIVE),
                    isNull(Media.recycle_time),
                    ...(lastMediaId ? [gt(Media.id, lastMediaId)] : []),
                ),
            )
            .orderBy(asc(Media.id))
            .limit(batchSize);

        const last = mediaBatch[mediaBatch.length - 1];
        return {
            units: mediaBatch.map((media) => ({
                unitKey: `ai:${media.id}`,
                kind: AsyncTaskUnitKind.AI_ENRICHMENT,
                subjectType: AsyncSubjectType.MEDIA,
                subjectId: media.id,
                inputSnapshot: { media_id: media.id },
            })),
            nextCursor: last ? { lastMediaId: last.id } : null,
            hasMore: mediaBatch.length === batchSize,
        };
    },

    async execute(context: TaskUnitContext): Promise<TaskResult> {
        context.signal.throwIfAborted();
        const mediaId = context.unit.subject_id;
        const mediaList = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .limit(1);
        const media = mediaList[0];

        if (!media) {
            // Recycled or purged media are out of scope for AI enrichment; settle as skipped
            // instead of failing a unit that can never succeed.
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
            eid: media.eid,
            source: media.source,
            title: media.title,
            description: media.description,
            author_name: "",
            author_external_id: null,
            url: "",
            published_time: media.published_time,
        };

        try {
            context.signal.throwIfAborted();
            await AiEnrichmentService.enrichMediaItem(media, postContext, context.signal);
            context.signal.throwIfAborted();
            return { success: true };
        } catch (error) {
            const classification = classifyAiError(error);
            const dependencyPending = error instanceof CoverNotReadyError;
            return {
                success: false,
                error: getSafeAiErrorMessage(error),
                retryable: dependencyPending || classification.retryable,
                retryReason: dependencyPending
                    ? TaskRetryReason.DEPENDENCY_PENDING
                    : classification.kind === "THROTTLED"
                      ? TaskRetryReason.THROTTLED
                      : undefined,
                retryAfterSeconds: classification.retryAfterMs !== undefined ? classification.retryAfterMs / 1000 : undefined,
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
