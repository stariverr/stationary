import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { serve } from "@upstash/workflow/hono";
import { Client } from "@upstash/workflow";
import { env } from "@/global/env";
import { Temporal } from "@js-temporal/polyfill";
import { TaskService } from "@/services/task";
import { VideoCoverService } from "@/services/video_cover";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { db } from "@/global/db";
import {
    Library,
    File as DbFile,
    DeleteStatus,
    SyncStatus,
    TrackType,
    TrackPurpose,
    PostSource,
    MediaType,
    EntityType,
    ProcessingStatus,
    AssetAiMetadata,
    Media,
    Post,
    Track,
} from "@/db/schema";
import { eq, and, lt, inArray, sql } from "drizzle-orm";
import { DeleteService } from "@/services/delete";
import { s3 } from "@/global/s3";
import { Quality } from "@/lib/types";

const taskApp = new Hono<AuthEnv>();

const AuthorSchema = z.object({
    name: z.string().default(""),
    /** Author can have no short_id */
    short_id: z.string().optional(),
    /** Author can have no external_id */
    external_id: z.string().optional(),
    avatar_file_url: z.string().nullable().optional(),
    signature: z.string().nullable().optional(),
});

const TimestampSchema = z
    .preprocess((val) => (val === null || val === "" ? undefined : val), z.string().optional())
    .transform((val) => {
        if (val === undefined) return undefined;
        // Handle Unix timestamps (numeric strings)
        if (/^\d+$/.test(val)) {
            const num = Number.parseInt(val);
            // If it's 10 digits, assume seconds; if 13, assume milliseconds
            if (val.length === 10) return Temporal.Instant.fromEpochMilliseconds(num * 1000);
            if (val.length === 13) return Temporal.Instant.fromEpochMilliseconds(num);
            // Fallback for other lengths
            return Temporal.Instant.fromEpochMilliseconds(num);
        }
        return Temporal.Instant.from(val);
    });

const SegmentBaseSchema = z.object({
    initialization: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    index_range: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
});

const TrackMetadataSchema = z.object({
    codecs: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    bandwidth: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
    width: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
    height: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
    duration: z
        .number()
        .nullish()
        .transform((v) => v ?? undefined),
    language: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    label: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    format: z
        .string()
        .nullish()
        .transform((v) => v ?? undefined),
    type: z
        .enum(["mp4", "fmp4"])
        .nullish()
        .transform((v) => v ?? undefined),
    segment_base: SegmentBaseSchema.nullish().transform((v) => v ?? undefined),
});

const TrackSchema = z.object({
    url: z.string(),
    type: z.enum(TrackType),
    purpose: z.enum(TrackPurpose).default(TrackPurpose.CONTENT),
    is_original: z.boolean().default(true),
    quality: z.enum(Quality).default(Quality.ORIGINAL),
    priority: z.number().default(0),
    metadata: TrackMetadataSchema.nullish().transform((v) => v ?? {}),
});

const MediaItemSchema = z
    .object({
        external_id: z.string().optional(),
        title: z
            .string()
            .nullish()
            .transform((v) => v ?? ""),
        description: z
            .string()
            .nullish()
            .transform((v) => v ?? ""),
        type: z.enum(MediaType),
        tracks: z.array(TrackSchema).default([]),
        tags: z.array(z.string()).default([]),
        /** Media Duration (in seconds) */
        duration: z.number().nullable().optional(),
        published_time: TimestampSchema.optional(),
        /** @deprecated Use published_time. Kept for legacy import payloads. */
        create_time: TimestampSchema.optional(),
    })
    .transform(({ create_time, published_time, ...media }) => ({
        ...media,
        published_time: published_time ?? create_time,
    }));

const PostItemSchema = z
    .object({
        title: z.string(),
        url: z.string().optional(),
        description: z.string().default(""),
        external_id: z.string().optional().default(""),
        tags: z.array(z.string()).default([]),
        author: AuthorSchema,
        platform: z.enum(PostSource),
        media: z.array(MediaItemSchema),
        published_time: TimestampSchema.optional(),
        /** @deprecated Use published_time. Kept for legacy import payloads. */
        create_time: TimestampSchema.optional(),
    })
    .transform(({ create_time, published_time, ...post }) => ({
        ...post,
        published_time: published_time ?? create_time,
    }));

export const CreateTaskSchema = z.object({
    library_id: z.uuid(),
    posts: z.array(PostItemSchema),
});

const WorkflowPayloadSchema = z.object({
    posts: z.array(
        z.object({
            data: PostItemSchema,
            id: z.string(),
            authorId: z.string().nullable(),
        }),
    ),
});

export type AuthorData = z.infer<typeof AuthorSchema>;
export type MediaItemData = z.infer<typeof MediaItemSchema>;
export type PostItemData = z.infer<typeof PostItemSchema>;
export type CreateTaskPayload = z.infer<typeof CreateTaskSchema>;
export type WorkflowPayload = z.infer<typeof WorkflowPayloadSchema>;

// Endpoint to create a task
taskApp.post("/create", requireAuth, zValidator("json", CreateTaskSchema), async (c) => {
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

    if (!env.QSTASH_TOKEN) {
        return c.json(error(Code.SERVICE_UNAVAILABLE, "QSTASH_TOKEN is not configured"), 500);
    }

    const client = new Client({ token: env.QSTASH_TOKEN });

    // Get the base URL form the request
    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);
    const workflowUrl = `${origin.replace(/\/$/, "")}/api/task/workflow`;

    const customWorkflowRunId = crypto.randomUUID();
    const postsToProcess: Array<{
        data: PostItemData;
        id: string;
        authorId: string | null;
    }> = [];

    // Step 1: Save Metadata of Post to DB (Synchronization & Deduplication) synchronously
    for (const postData of payload.posts) {
        const stepOneResult = await TaskService.saveMetadata(postData, payload.library_id, customWorkflowRunId);

        // The result of Step 1 can determine whether the following steps should be executed.
        if (!stepOneResult.skipUpdate) {
            postsToProcess.push({
                data: postData,
                id: stepOneResult.postId,
                authorId: stepOneResult.authorId,
            });
        }
    }

    if (postsToProcess.length > 0) {
        await client.trigger({
            url: workflowUrl,
            body: { posts: postsToProcess },
            headers: {
                "Content-Type": "application/json",
            },
            workflowRunId: customWorkflowRunId,
        });
    }

    return c.json(
        success(Code.SUCCESS, {
            message: "Tasks received and metadata processed",
            count: payload.posts.length,
            processedCount: postsToProcess.length,
            workflowUrl: postsToProcess.length > 0 ? workflowUrl : undefined,
        }),
    );
});

// Upstash Workflow handler
export const workflowHandler = serve(
    async (context) => {
        const { posts } = WorkflowPayloadSchema.parse(context.requestPayload);

        for (const post of posts) {
            // Step 2: Process And Upload Media
            for (const [index, mediaData] of post.data.media.entries()) {
                await context.run(`process-media-${post.id}-${index}`, async () => {
                    await TaskService.processMedia(post.id, index, mediaData);
                });
            }

            // Step 3: Process And Upload Avatar
            if (post.data.author.avatar_file_url && post.authorId) {
                await context.run(`process-avatar-${post.authorId}`, async () => {
                    await TaskService.processAvatar(post.authorId!, post.data.author.avatar_file_url!);
                });
            }

            // Step 4: Update Post Status to COMPLETED
            await context.run(`finalize-post-${post.id}`, async () => {
                await TaskService.finalizePost(post.id);
            });
        }
    },
    {
        failureFunction: async ({ context, failResponse }) => {
            // Mark posts associated with this workflow as FAILED
            await TaskService.markPostAsFailed(context.workflowRunId, failResponse || "Workflow retries exhausted.");
        },
    },
);

// Cron endpoint to purge expired soft-deleted files
taskApp.post("/purge-expired-files", async (c) => {
    const thirtyDaysAgo = Temporal.Now.instant().subtract({ hours: 30 * 24 });

    const expiredFiles = await db
        .select()
        .from(DbFile)
        .where(and(eq(DbFile.delete_status, DeleteStatus.DELETED), lt(DbFile.delete_time, thirtyDaysAgo)));

    let purgedCount = 0;
    let failedCount = 0;
    const errors: Array<{ fileId: string; error: string }> = [];

    for (const file of expiredFiles) {
        try {
            const canPurge = await DeleteService.canPurgeFile(file.id);
            if (canPurge) {
                try {
                    await s3.delete(file.path, { bucket: file.bucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound") {
                        throw s3Err;
                    }
                }

                await db.delete(DbFile).where(eq(DbFile.id, file.id));
                purgedCount++;
            }
        } catch (e: any) {
            failedCount++;
            errors.push({ fileId: file.id, error: e.message || String(e) });
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

const CoverWorkflowPayloadSchema = z.object({
    mediaId: z.uuid(),
    force: z.boolean().optional(),
    replaceExternalCover: z.boolean().optional(),
});

export const coverWorkflowHandler = serve(
    async (context) => {
        const { mediaId, force, replaceExternalCover } = CoverWorkflowPayloadSchema.parse(context.requestPayload);

        await context.run(`generate-cover-${mediaId}`, async () => {
            await VideoCoverService.generateForMedia(mediaId, { force, replaceExternalCover });
        });
    },
    {
        failureFunction: async ({ context, failResponse }) => {
            console.error(`[VIDEO COVER WORKFLOW FAILED] Workflow Run: ${context.workflowRunId}. Reason: ${failResponse}`);
            const { mediaId } = CoverWorkflowPayloadSchema.parse(context.requestPayload);
            try {
                await db
                    .insert(Track)
                    .values({
                        media_id: mediaId,
                        type: TrackType.IMAGE,
                        purpose: TrackPurpose.COVER,
                        quality: Quality.ORIGINAL,
                        priority: 0,
                        sync_status: SyncStatus.FAILED,
                        last_error: failResponse || "Workflow retries exhausted.",
                    })
                    .onConflictDoUpdate({
                        target: [Track.media_id, Track.type, Track.purpose, Track.variant_key],
                        targetWhere: sql`delete_status = 'ACTIVE'`,
                        set: {
                            sync_status: SyncStatus.FAILED,
                            last_error: failResponse || "Workflow retries exhausted.",
                            delete_status: DeleteStatus.ACTIVE,
                            delete_time: null,
                        },
                    });
            } catch (dbErr) {
                console.error(`[VIDEO COVER WORKFLOW] Failed to write failure status to DB:`, dbErr);
            }
        },
    },
);

taskApp.post("/scan-missing-covers", async (c) => {
    // Auth Check:
    // If CRON_SECRET is configured, validate authorization
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
        // If CRON_SECRET is missing in production, reject for security
        if (process.env.NODE_ENV === "production") {
            return c.json(error(Code.SERVICE_UNAVAILABLE, "CRON_SECRET is not configured in production"), 500);
        }
    }

    let body: { library_id?: string; limit?: number; stale_minutes?: number } = {};
    try {
        body = await c.req.json();
    } catch {
        // Safe fallback for empty body
    }

    // Get the base URL from request
    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);

    try {
        const result = await VideoCoverService.scanAndQueueMissingCovers({
            libraryId: body.library_id,
            limit: body.limit,
            staleMinutes: body.stale_minutes,
            originUrl: origin,
        });

        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to run scanAndQueueMissingCovers: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to retry sync for failed items
const RetrySyncSchema = z.object({
    post_ids: z.array(z.string().uuid()).optional(),
    media_ids: z.array(z.string().uuid()).optional(),
});

taskApp.post("/retry-sync", requireAuth, zValidator("json", RetrySyncSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const payload = c.req.valid("json");
    if (!payload.post_ids?.length && !payload.media_ids?.length) {
        return c.json(error(Code.INVALID_PARAMETER, "At least one post_id or media_id is required"), 400);
    }

    // Auth verification: ensure all requested posts/medias belong to libraries owned by the user
    const resolvedPostIds = new Set<string>(payload.post_ids || []);
    if (payload.media_ids?.length) {
        const mediaList = await db.select({ post_id: Media.post_id }).from(Media).where(inArray(Media.id, payload.media_ids));
        for (const m of mediaList) {
            if (m.post_id) {
                resolvedPostIds.add(m.post_id);
            }
        }
    }

    const postIds = Array.from(resolvedPostIds);
    if (postIds.length > 0) {
        const posts = await db.select({ library_id: Post.library_id }).from(Post).where(inArray(Post.id, postIds));

        const uniqueLibraryIds = Array.from(new Set(posts.map((p) => p.library_id)));
        if (uniqueLibraryIds.length > 0) {
            const libraries = await db.select({ owner_id: Library.owner_id }).from(Library).where(inArray(Library.id, uniqueLibraryIds));

            const isAuthorized = libraries.every((lib) => lib.owner_id === user.id);
            if (!isAuthorized) {
                return c.json(error(Code.UNAUTHORIZED, "You do not have access to some of the libraries"), 403);
            }
        }
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);

    try {
        const result = await TaskService.retrySync({
            postIds: payload.post_ids,
            mediaIds: payload.media_ids,
            originUrl: origin,
        });

        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to sweep tasks stuck in IN_PROGRESS for too long
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
        const result = await TaskService.sweepStuckTasks(thresholdMinutes);
        return c.json(success(Code.SUCCESS, result));
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
        const { sweepOrphanTags } = await import("@/scripts/sweep_orphans");
        const result = await sweepOrphanTags();
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        console.error(`[task] Failed to sweep orphan tags: ${errorMsg}`);
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

// Endpoint to queue items for AI enrichment
const QueueAiSchema = z.object({
    post_ids: z.array(z.string().uuid()).optional(),
    media_ids: z.array(z.string().uuid()).optional(),
});

taskApp.post("/queue-ai", requireAuth, zValidator("json", QueueAiSchema), async (c) => {
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

    // 1. Initialize AssetAiMetadata status to PENDING
    const { AiService } = await import("@/services/ai/service");
    for (const media of mediaList) {
        const aiService = await AiService.forLibrary(media.library_id);
        const metadataPipelineId = aiService?.metadataPipelineId || "default";
        const model = aiService?.chatModelName || "none";

        await db
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

    // 2. Trigger QStash workflow for AI enrichment
    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);
    const workflowUrl = `${origin.replace(/\/$/, "")}/api/task/workflow-ai`;

    const client = new Client({ token: env.QSTASH_TOKEN });
    const customWorkflowRunId = crypto.randomUUID();

    try {
        await client.trigger({
            url: workflowUrl,
            body: { mediaIds: finalMediaIds },
            headers: {
                "Content-Type": "application/json",
            },
            workflowRunId: customWorkflowRunId,
        });

        return c.json(
            success(Code.SUCCESS, {
                count: finalMediaIds.length,
                workflowRunId: customWorkflowRunId,
            }),
        );
    } catch (e: any) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        // Reset status to FAILED in case of QStash trigger failure
        for (const mediaId of finalMediaIds) {
            await db
                .update(AssetAiMetadata)
                .set({
                    processing_status: ProcessingStatus.FAILED,
                    last_error: errorMsg,
                    update_time: sql`now()`,
                })
                .where(and(eq(AssetAiMetadata.entity_id, mediaId), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)));
        }
        return c.json(error(Code.INTERNAL_SERVER_ERROR, errorMsg), 500);
    }
});

const AiWorkflowPayloadSchema = z.object({
    mediaIds: z.array(z.string()),
});

export const aiWorkflowHandler = serve(
    async (context) => {
        const { mediaIds } = AiWorkflowPayloadSchema.parse(context.requestPayload);
        const { AiEnrichmentService } = await import("@/services/ai/enrich");

        for (const mediaId of mediaIds) {
            await context.run(`ai-enrich-${mediaId}`, async () => {
                const mediaList = await db
                    .select()
                    .from(Media)
                    .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                    .limit(1);
                const media = mediaList[0];
                if (!media) return;

                let post = null;
                if (media.post_id) {
                    const postList = await db
                        .select()
                        .from(Post)
                        .where(and(eq(Post.id, media.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                        .limit(1);
                    post = postList[0] || null;
                }

                // If no post, construct dummy Post to satisfy enrichMediaItem signature
                const postObj =
                    post ||
                    ({
                        id: "",
                        source: media.source,
                        title: media.title,
                        description: media.description,
                        tags: [],
                        author_name: "",
                    } as any);

                await AiEnrichmentService.enrichMediaItem(media, postObj);
            });
        }
    },
    {
        failureFunction: async ({ context, failResponse }) => {
            console.error(`[AI WORKFLOW FAILED] Workflow Run: ${context.workflowRunId}. Reason: ${failResponse}`);
            const { mediaIds } = AiWorkflowPayloadSchema.parse(context.requestPayload);
            const errorMsg = failResponse || "Workflow retries exhausted.";
            for (const mediaId of mediaIds) {
                const aiMetadataList = await db
                    .select()
                    .from(AssetAiMetadata)
                    .where(and(eq(AssetAiMetadata.entity_id, mediaId), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)))
                    .limit(1);
                const aiMetadata = aiMetadataList[0];
                if (aiMetadata) {
                    await db
                        .update(AssetAiMetadata)
                        .set({
                            processing_status: ProcessingStatus.FAILED,
                            last_error: errorMsg,
                            update_time: sql`now()`,
                        })
                        .where(eq(AssetAiMetadata.id, aiMetadata.id));
                }
            }
        },
    },
);

const CopyAvatarWorkflowPayloadSchema = z.object({
    sourceAuthorId: z.uuid(),
    targetAuthorId: z.uuid(),
});

export const copyAvatarWorkflowHandler = serve(async (context) => {
    const { sourceAuthorId, targetAuthorId } = CopyAvatarWorkflowPayloadSchema.parse(context.requestPayload);

    await context.run(`copy-avatar-${sourceAuthorId}-to-${targetAuthorId}`, async () => {
        await TaskService.copyAuthorAvatar(sourceAuthorId, targetAuthorId);
    });
});

taskApp.all(
    "/workflow",
    async (c, next) => {
        console.log(`[DEBUG] Incoming request to /api/task/workflow`);
        return next();
    },
    workflowHandler,
);

taskApp.all(
    "/workflow-cover",
    async (c, next) => {
        console.log(`[DEBUG] Incoming request to /api/task/workflow-cover`);
        return next();
    },
    coverWorkflowHandler,
);

taskApp.all(
    "/workflow-ai",
    async (c, next) => {
        console.log(`[DEBUG] Incoming request to /api/task/workflow-ai`);
        return next();
    },
    aiWorkflowHandler,
);

taskApp.all(
    "/workflow-copy-avatar",
    async (c, next) => {
        console.log(`[DEBUG] Incoming request to /api/task/workflow-copy-avatar`);
        return next();
    },
    copyAvatarWorkflowHandler,
);

export default taskApp;
