import { Hono } from "hono";
import * as v from "valibot";
import { validate } from "@/lib/validation/validator";
import { env } from "@/global/env";

import { TaskService } from "@/services/task";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { db } from "@/global/db";
import {
    Library,
    File as DbFile,
    DeleteStatus,
    TrackType,
    TrackPurpose,
    TrackStreamLayout,
    PostSource,
    MediaType,
    EntityType,
    ProcessingStatus,
    AssetAiMetadata,
    Media,
    Post,
    DraftFile,
    DraftFileStatus,
    AsyncTaskType,
    AsyncTaskUnitKind,
    AsyncSubjectType,
} from "@/db/schema";
import { eq, and, lt, inArray, sql } from "drizzle-orm";

import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import { JobSweeper } from "@/infra/jobs/sweeper";
import type { DiscoveredUnitSpec } from "@/infra/jobs/types";
import { createIdempotencyKey } from "@/lib/utils/hash";
import { AiService } from "@/services/ai/service";
import { sweepOrphanTags } from "@/scripts/sweep_orphans";
import { runMediaTrackIntegrityScan } from "@/audit/media-track";
import { s3 } from "@/global/s3";
import { Quality } from "@/lib/types";

import {
    CreateTaskSchema,
    type AuthorData,
    type MediaItemData,
    type PostItemData,
    type CreateTaskPayload,
    type WorkflowPayload,
} from "@/api/schemas/ingest";

export { CreateTaskSchema };
export type { AuthorData, MediaItemData, PostItemData, CreateTaskPayload, WorkflowPayload };

const taskApp = new Hono<AuthEnv>();

// Endpoint to create a task
taskApp.post("/create", requireAuth, validate("json", CreateTaskSchema), async (c) => {
    const user = c.get("user");
    const apiToken = c.get("apiToken");

    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");

    // 1. Verify library exists
    const libs = await db.select().from(Library).where(eq(Library.id, payload.library_id)).limit(1);
    const library = libs[0];
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Target library not found"), 404);
    }

    // 2. Perform library scoping and ownership validation
    if (apiToken) {
        // If API token is scoped to a specific library, check that target matches scope
        if (apiToken.library_id && apiToken.library_id !== payload.library_id) {
            return c.json(error(Code.UNAUTHORIZED, "API token is not scoped for this library"), 403);
        }

        // Ensure library belongs to the token owner
        if (library.owner_id !== user.id) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
        }
    } else {
        // Logged-in session user, check ownership
        if (library.owner_id !== user.id) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
        }
    }

    const createdTaskIds: string[] = [];

    for (const postData of payload.posts) {
        const customWorkflowRunId = crypto.randomUUID();

        const taskId = await db.transaction(async (tx) => {
            const stepOneResult = await TaskService.saveMetadata(postData, payload.library_id, customWorkflowRunId, tx);

            if (stepOneResult.skipUpdate) {
                return null;
            }

            const mediaList = await tx
                .select()
                .from(Media)
                .where(and(eq(Media.post_id, stepOneResult.postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            const unitSpecs: DiscoveredUnitSpec[] = mediaList.map((m) => ({
                unitKey: `media:${m.id}`,
                kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                subjectType: AsyncSubjectType.MEDIA,
                subjectId: m.id,
                inputSnapshot: { post_id: stepOneResult.postId, media_id: m.id },
            }));

            if (stepOneResult.authorId && postData.author.avatar_file_url) {
                unitSpecs.push({
                    unitKey: `avatar:${stepOneResult.authorId}`,
                    kind: AsyncTaskUnitKind.AVATAR_DOWNLOAD,
                    subjectType: AsyncSubjectType.AUTHOR,
                    subjectId: stepOneResult.authorId,
                    inputSnapshot: { author_id: stepOneResult.authorId, avatar_url: postData.author.avatar_file_url },
                });
            }

            const masterTask = await JobManager.enqueueTaskWithUnits(
                {
                    type: AsyncTaskType.POST_PROCESS,
                    libraryId: payload.library_id,
                    ownerId: user.id,
                    inputSnapshot: { post_id: stepOneResult.postId, workflow_run_id: customWorkflowRunId },
                    idempotencyKey: createIdempotencyKey("post_process", {
                        postId: stepOneResult.postId,
                        workflowRunId: customWorkflowRunId,
                    }),
                },
                unitSpecs,
                tx,
            );

            return masterTask.id;
        });

        if (taskId) {
            createdTaskIds.push(taskId);
        }
    }

    jobRunner.wake();

    return c.json(
        success(Code.SUCCESS, {
            message: "Tasks received and metadata processed",
            count: payload.posts.length,
            processedCount: createdTaskIds.length,
            task_ids: createdTaskIds,
        }),
    );
});

// Cron endpoint to purge expired soft-deleted files
taskApp.post("/purge-expired-files", async (c) => {
    const thirtyDaysAgo = Temporal.Now.instant().subtract({ hours: 30 * 24 });
    const BATCH_SIZE = 500;

    let purgedCount = 0;
    let failedCount = 0;
    const errors: Array<{ fileId: string; error: string }> = [];

    while (true) {
        const expiredFiles = await db
            .select()
            .from(DbFile)
            .where(and(eq(DbFile.delete_status, DeleteStatus.DELETED), lt(DbFile.delete_time, thirtyDaysAgo)))
            .limit(BATCH_SIZE);

        if (expiredFiles.length === 0) break;

        for (const file of expiredFiles) {
            try {
                try {
                    await s3.delete(file.path, { bucket: file.bucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound" && s3Err.name !== "NoSuchKey") {
                        throw s3Err;
                    }
                }

                await db.delete(DbFile).where(eq(DbFile.id, file.id));
                purgedCount++;
            } catch (e: any) {
                failedCount++;
                errors.push({ fileId: file.id, error: e.message || String(e) });
            }
        }
    }

    return c.json(
        success(Code.SUCCESS, {
            purgedCount,
            failedCount,
            errors,
        }),
    );
});

// Cron endpoint to purge stale PENDING uploads that were never confirmed
taskApp.post("/purge-stale-pending-drafts", async (c) => {
    // Auth Check: Validate cron secret
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");
        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }
        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    // Set expiration threshold to 2 hours ago
    const twoHoursAgo = Temporal.Now.instant().subtract({ hours: 2 });
    const BATCH_SIZE = 500;

    let purgedCount = 0;
    let failedCount = 0;
    const errors: Array<{ draftId: string; error: string }> = [];

    while (true) {
        const staleDrafts = await db
            .select({
                draftId: DraftFile.id,
                fileId: DbFile.id,
                filePath: DbFile.path,
                fileBucket: DbFile.bucket,
            })
            .from(DraftFile)
            .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
            .where(and(eq(DraftFile.status, DraftFileStatus.PENDING), lt(DraftFile.create_time, twoHoursAgo)))
            .limit(BATCH_SIZE);

        if (staleDrafts.length === 0) break;

        for (const draft of staleDrafts) {
            try {
                try {
                    await s3.delete(draft.filePath, { bucket: draft.fileBucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound" && s3Err.name !== "NoSuchKey") {
                        throw s3Err;
                    }
                }

                await db.transaction(async (tx) => {
                    await tx.delete(DraftFile).where(eq(DraftFile.id, draft.draftId));
                    await tx.delete(DbFile).where(eq(DbFile.id, draft.fileId));
                });
                purgedCount++;
            } catch (e: any) {
                failedCount++;
                errors.push({ draftId: draft.draftId, error: e.message || String(e) });
            }
        }
    }

    return c.json(
        success(Code.SUCCESS, {
            purgedCount,
            failedCount,
            errors,
        }),
    );
});

// Endpoint to retry sync for failed items
const RetrySyncSchema = v.object({
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
});

taskApp.post("/retry-sync", requireAuth, validate("json", RetrySyncSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");
    if (!payload.post_ids?.length && !payload.media_ids?.length) {
        return c.json(error(Code.INVALID_PARAMETER, "At least one post_id or media_id is required"), 400);
    }

    // Auth verification: ensure all requested posts/media belong to libraries owned by the user.
    const resolvedPostIds = new Set<string>(payload.post_ids || []);
    const requestedLibraryIds = new Set<string>();
    if (payload.media_ids?.length) {
        const mediaList = await db
            .select({ post_id: Media.post_id, library_id: Media.library_id })
            .from(Media)
            .where(inArray(Media.id, payload.media_ids));
        for (const media of mediaList) {
            requestedLibraryIds.add(media.library_id);
            if (media.post_id) {
                resolvedPostIds.add(media.post_id);
            }
        }
    }

    const postIds = Array.from(resolvedPostIds);
    if (postIds.length > 0) {
        const posts = await db.select({ library_id: Post.library_id }).from(Post).where(inArray(Post.id, postIds));
        for (const post of posts) {
            requestedLibraryIds.add(post.library_id);
        }
    }

    const uniqueLibraryIds = Array.from(requestedLibraryIds);
    if (uniqueLibraryIds.length > 0) {
        const libraries = await db.select({ owner_id: Library.owner_id }).from(Library).where(inArray(Library.id, uniqueLibraryIds));

        const isAuthorized = libraries.length === uniqueLibraryIds.length && libraries.every((lib) => lib.owner_id === user.id);
        if (!isAuthorized) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to some of the libraries"), 403);
        }
    }

    try {
        const result = await TaskService.retrySync({
            postIds: payload.post_ids,
            mediaIds: payload.media_ids,
        });

        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

/**
 * Universal endpoint to sweep stuck background processes and jobs.
 *
 * Performs a two-tier cleanup:
 * 1. Entity-level sync timeout sweep: Marks legacy entity records (Post, Media, Track) stuck in IN_PROGRESS as FAILED.
 * 2. Generic async job system sweep (JobSweeper): Reclaims expired task unit leases, dispatches pending units,
 *    reconciles completed tasks, and purges obsolete job records across all registered AsyncTask types automatically.
 */
taskApp.post("/sweep-stuck-tasks", async (c) => {
    // Auth Check: Validate cron secret
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");

        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }

        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    let thresholdMinutes = 30;
    try {
        const body = await c.req.json();
        if (body && typeof body.threshold_minutes === "number") {
            thresholdMinutes = body.threshold_minutes;
        }
    } catch {
        // Fallback to default
    }

    try {
        // Step 1: Sweep legacy entity sync statuses (Post / Media / Track)
        const entityResult = await TaskService.sweepStuckTasks(thresholdMinutes);
        // Step 2: Execute full generic sweep across all registered AsyncTask job handlers
        const jobResult = await JobSweeper.runSweep();

        return c.json(
            success(Code.SUCCESS, {
                stuck_entities_swept: entityResult.sweptCount,
                async_job_sweep: jobResult,
            }),
        );
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep stuck tasks: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to sweep orphan tags
taskApp.post("/sweep-orphan-tags", async (c) => {
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");

        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }

        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else {
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    try {
        const result = await sweepOrphanTags();
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep orphan tags: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to reconcile Media / Track / File logical references

taskApp.post("/sweep-media-track-integrity", async (c) => {
    const cronSecret = env.CRON_SECRET;
    if (cronSecret) {
        const authHeader = c.req.header("Authorization");
        const internalHeader = c.req.header("X-Internal-Token");
        let token = "";
        if (authHeader && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        } else if (internalHeader) {
            token = internalHeader;
        }
        if (token !== cronSecret) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }
    } else if (process.env.NODE_ENV === "production") {
        return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
    }

    try {
        const report = await runMediaTrackIntegrityScan();
        return c.json(success(Code.SUCCESS, report));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to reconcile media/track integrity: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to queue items for AI enrichment
const QueueAiSchema = v.object({
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
});

taskApp.post("/queue-ai", requireAuth, validate("json", QueueAiSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");
    if (!payload.post_ids?.length && !payload.media_ids?.length) {
        return c.json(error(Code.INVALID_PARAMETER, "At least one post_id or media_id is required"), 400);
    }

    // Resolve media IDs from the database
    const targetMediaIds = new Set<string>();

    if (payload.post_ids?.length) {
        const mediaList = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(inArray(Media.post_id, payload.post_ids), eq(Media.delete_status, DeleteStatus.ACTIVE)));
        for (const m of mediaList) {
            targetMediaIds.add(m.id);
        }
    }

    if (payload.media_ids?.length) {
        for (const id of payload.media_ids) {
            targetMediaIds.add(id);
        }
    }

    const finalMediaIds = Array.from(targetMediaIds);
    if (finalMediaIds.length === 0) {
        return c.json(success(Code.SUCCESS, { count: 0, message: "No active media items found to enrich" }));
    }

    // Authorization verification: verify user owns all associated libraries
    const mediaList = await db.select({ id: Media.id, library_id: Media.library_id }).from(Media).where(inArray(Media.id, finalMediaIds));

    const uniqueLibraryIds = Array.from(new Set(mediaList.map((m) => m.library_id)));
    if (uniqueLibraryIds.length > 0) {
        const libraries = await db.select({ owner_id: Library.owner_id }).from(Library).where(inArray(Library.id, uniqueLibraryIds));

        const isAuthorized = libraries.every((lib) => lib.owner_id === user.id);
        if (!isAuthorized) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to some of the libraries"), 403);
        }
    }

    const masterTask = await db.transaction(async (tx) => {
        for (const media of mediaList) {
            const aiService = await AiService.forLibrary(media.library_id);
            const metadataPipelineId = aiService?.metadataPipelineId || "default";
            const model = aiService?.chatModelName || "none";

            await tx
                .insert(AssetAiMetadata)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    metadata_pipeline_id: metadataPipelineId,
                    model: model,
                    processing_status: ProcessingStatus.PENDING,
                    last_error: null,
                })
                .onConflictDoUpdate({
                    target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id, AssetAiMetadata.metadata_pipeline_id],
                    set: {
                        processing_status: ProcessingStatus.PENDING,
                        last_error: null,
                        update_time: sql`now()`,
                    },
                });
        }

        const unitSpecs: DiscoveredUnitSpec[] = finalMediaIds.map((mediaId) => ({
            unitKey: `ai:${mediaId}`,
            kind: AsyncTaskUnitKind.AI_ENRICHMENT,
            subjectType: AsyncSubjectType.MEDIA,
            subjectId: mediaId,
            inputSnapshot: { media_id: mediaId },
        }));

        return await JobManager.enqueueTaskWithUnits(
            {
                type: AsyncTaskType.AI_ENRICH,
                ownerId: user.id,
                inputSnapshot: { media_ids: finalMediaIds },
            },
            unitSpecs,
            tx,
        );
    });

    jobRunner.wake();

    return c.json(
        success(Code.SUCCESS, {
            count: finalMediaIds.length,
            taskId: masterTask.id,
        }),
    );
});

export default taskApp;
