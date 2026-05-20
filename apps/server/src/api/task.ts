import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { serve } from "@upstash/workflow/hono";
import { Client } from "@upstash/workflow";
import { env } from "@/global/env";
import { Temporal } from "@js-temporal/polyfill";
import { TaskService } from "@/services/task";
import { Code } from "@/lib/code";
import { error, success } from "@/lib/response";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { db } from "@/global/db";
import { Library } from "@/db/schema";
import { eq } from "drizzle-orm";

const taskApp = new Hono<AuthEnv>();

const AuthorSchema = z.object({
    name: z.string().default(""),
    /** Author can have no short_id */
    short_id: z.string().optional(),
    /** Author can have no external_id */
    external_id: z.string().optional(),
    avatar_file_url: z.string().nullable().optional(),
});

const TimestampSchema = z.string().transform((val) => {
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

const MediaItemSchema = z.object({
    external_id: z.string().optional(),
    title: z.string().nullable().default(""),
    description: z.string().nullable().default(""),
    type: z.enum(["IMAGE", "VIDEO", "LIVE_PHOTO"]),
    primary_file_url: z.string(),
    alternative_file_url: z.string().nullable().optional(),
    live_photo_video_url: z.string().nullable().optional(),
    cover_file_url: z.string().nullable().optional(),
    /** Media Duration (in seconds) */
    duration: z.number().nullable().optional(),
    published_time: TimestampSchema.optional(),
    /** @deprecated Use published_time. Kept for legacy import payloads. */
    create_time: TimestampSchema.optional(),
}).transform(({ create_time, published_time, ...media }) => ({
    ...media,
    published_time: published_time ?? create_time,
}));

const PostItemSchema = z.object({
    title: z.string(),
    url: z.string().optional(),
    description: z.string().default(""),
    external_id: z.string().optional().default(""),
    tags: z.array(z.string()).default([]),
    author: AuthorSchema,
    platform: z.enum(["UNKNOWN", "X", "XHS", "BILIBILI", "DOUYIN", "TIKTOK", "INSTAGRAM"]),
    media: z.array(MediaItemSchema),
    published_time: TimestampSchema.optional(),
    /** @deprecated Use published_time. Kept for legacy import payloads. */
    create_time: TimestampSchema.optional(),
}).transform(({ create_time, published_time, ...post }) => ({
    ...post,
    published_time: published_time ?? create_time,
}));

export const CreateTaskSchema = z.object({
    library_id: z.uuid(),
    posts: z.array(PostItemSchema),
});

const WorkflowPayloadSchema = z.object({
    posts: z.array(z.object({
        data: PostItemSchema,
        id: z.string(),
        authorId: z.string().nullable(),
    }))
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
    const origin = env.UPSTASH_WORKFLOW_URL || (c.req.header("x-forwarded-proto")
        ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}`
        : url.origin);
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

    return c.json(success(Code.SUCCESS, {
        message: "Tasks received and metadata processed",
        count: payload.posts.length,
        processedCount: postsToProcess.length,
        workflowUrl: postsToProcess.length > 0 ? workflowUrl : undefined
    }));
});

// Upstash Workflow handler
export const workflowHandler = serve(async (context) => {
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

}, {
    failureFunction: async ({ context, failResponse }) => {
        // Mark posts associated with this workflow as FAILED
        await TaskService.markPostAsFailed(context.workflowRunId, failResponse || "Workflow retries exhausted.");
    }
});

taskApp.all("/workflow", async (c, next) => {
    console.log(`[DEBUG] Incoming request to /api/task/workflow`);
    // console.log(`[DEBUG] Method: ${c.req.method}`);
    // console.log(`[DEBUG] Content-Type: ${c.req.header("content-type")}`);
    // console.log(`[DEBUG] Content-Length: ${c.req.header("content-length")}`);
    return next();
}, workflowHandler);

export default taskApp;
