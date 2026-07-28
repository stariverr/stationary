import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validate } from "@/lib/validation/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import {
    DeleteStatus,
    Library,
    Media,
    Post,
    Tag,
    PostTag,
    MediaTag,
    Author,
    AsyncTask,
    AsyncTaskType,
    AsyncTaskStatus,
    AsyncTaskUnitKind,
    AsyncSubjectType,
} from "@/db/schema";
import { Quality } from "@/lib/types";

import { and, eq, ilike, SQL, count, inArray, isNull, sql, desc } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { DeleteService } from "@/services/delete";
import { JobManager } from "@/infra/jobs/manager";
import { Temporal } from "@js-temporal/polyfill";

const router = new Hono<AuthEnv>();

export const LibraryIdParamSchema = z.object({
    id: z.uuid("Invalid library ID format"),
});

export const LibraryListQuerySchema = z.object({
    page: z.preprocess((val) => (val === "" || val === undefined ? undefined : Number(val)), z.number().int().positive().gte(1).optional()),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(10).lte(100).optional(),
    ),
    keyword: z.string().optional(),
});

export const LibraryCreateBodySchema = z
    .object({
        name: z.string().min(1, "Name is required"),
        description: z.string().optional().default(""),
    })
    .strict();

export const LibraryUpdateBodySchema = z
    .object({
        id: z.uuid("Invalid library ID format"),
        name: z.string().min(1, "Name is required").optional(),
        description: z.string().optional(),
    })
    .strict();

export const LibraryMoveItemsBodySchema = z
    .object({
        post_ids: z.array(z.uuid("Invalid post ID format")).default([]),
        media_ids: z.array(z.uuid("Invalid media ID format")).default([]),
        target_library_id: z.uuid("Invalid target_library_id format"),
    })
    .strict()
    .refine((body) => body.post_ids.length > 0 || body.media_ids.length > 0, "At least one post or media id is required")
    .transform((data) => ({
        target_library_id: data.target_library_id,
        post_ids: uniqueIds(data.post_ids),
        media_ids: uniqueIds(data.media_ids),
    }));

export const LibraryAiConfigSchema = z.object({
    ai_provider: z.enum(["gemini", "openai"]).nullable().optional(),
    openai_api_key: z.string().nullable().optional(),
    openai_base_url: z.string().nullable().optional(),
    openai_model_embedding_text: z.string().nullable().optional(),
    openai_model_embedding_text_map_to: z.string().nullable().optional(),
    openai_model_embedding_image: z.string().nullable().optional(),
    openai_model_embedding_image_map_to: z.string().nullable().optional(),
    openai_model_describe_image: z.string().nullable().optional(),
    openai_model_describe_image_map_to: z.string().nullable().optional(),
    gemini_api_key: z.string().nullable().optional(),
    gemini_base_url: z.string().nullable().optional(),
});

export const LibraryCoverJobsBodySchema = z.object({
    type: z.enum(["MANUAL", "RECONCILE"]).optional().default("RECONCILE"),
    media_ids: z.array(z.uuid("Invalid media ID format")).optional(),
    qualities: z.array(z.enum(Quality)).optional(),
    force: z.boolean().default(false),
});

export const LibraryCoverConfigBodySchema = z.object({
    qualities: z
        .array(z.enum(Quality))
        .min(1, "At least 1 cover quality tier is required")
        .max(3, "At most 3 cover quality tiers are allowed")
        .transform((list) => {
            const set = new Set(list);
            const ordered: Quality[] = [];
            for (const q of [Quality.LOW, Quality.MEDIUM, Quality.HIGH]) {
                if (set.has(q)) ordered.push(q);
            }
            return ordered;
        }),
});

export const uniqueIds = (ids: string[]) => Array.from(new Set(ids));

export const getAttachedMediaIds = (media: Pick<typeof Media.$inferSelect, "id" | "post_id">[]) =>
    media.filter((item) => item.post_id !== null).map((item) => item.id);

function maskKey(key: string | null | undefined): string | null {
    if (!key) return null;
    if (key.length <= 8) return "********";
    return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

router.get("/list", requireAuth, validate("query", LibraryListQuerySchema), async (c) => {
    const query = c.req.valid("query");
    const page = query.page ?? 1;
    const pageSize = query.count ?? 20;
    const offset = (page - 1) * pageSize;
    const { keyword } = query;

    const where: SQL[] = [eq(Library.delete_status, DeleteStatus.ACTIVE)];
    if (keyword) {
        where.push(ilike(Library.name, `%${keyword}%`));
    }

    const libraries = await db
        .select()
        .from(Library)
        .where(and(...where))
        .limit(pageSize)
        .offset(offset);

    const totalResult = await db
        .select({ total: count() })
        .from(Library)
        .where(and(...where));

    return c.json(
        success(Code.SUCCESS, {
            list: libraries,
            total: totalResult[0]?.total ?? 0,
        }),
    );
});

router.post("/create", requireAuth, validate("json", LibraryCreateBodySchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const newLib = await db
        .insert(Library)
        .values({
            name: body.name,
            description: body.description,
            owner_id: user.id,
        })
        .returning();
    return c.json(success(Code.SUCCESS, newLib[0]));
});

router.post("/update", requireAuth, validate("json", LibraryUpdateBodySchema), async (c) => {
    const body = c.req.valid("json");
    const { id, ...updateData } = body;
    const updated = await db.update(Library).set(updateData).where(eq(Library.id, id)).returning();

    if (updated.length === 0) return c.json(error(Code.NOT_FOUND, "Library not found"));
    return c.json(success(Code.SUCCESS, updated[0]));
});

router.post("/delete/:id", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");

    try {
        const result = await DeleteService.deleteLibrary(id);
        if (result.libraryUpdated === 0) {
            return c.json(error(Code.NOT_FOUND, "Library not found"));
        }
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        if (e.message === "Library is not empty") {
            return c.json(error(Code.LIBRARY_NOT_EMPTY, "Please empty posts and media in this library before deleting it."));
        }
        throw e;
    }
});

router.post("/move-items", requireAuth, validate("json", LibraryMoveItemsBodySchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    const body = c.req.valid("json");

    const targetLibraries = await db
        .select({ id: Library.id })
        .from(Library)
        .where(and(eq(Library.id, body.target_library_id), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);

    if (targetLibraries.length === 0) {
        return c.json(error(Code.NOT_FOUND, "Target library not found"));
    }

    const moved = await db.transaction(async (tx) => {
        const selectedPosts =
            body.post_ids.length > 0
                ? await tx
                      .select({ id: Post.id, author_id: Post.author_id })
                      .from(Post)
                      .where(and(inArray(Post.id, body.post_ids), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                : [];

        if (selectedPosts.length !== body.post_ids.length) {
            throw new Error("One or more posts were not found or not active");
        }

        const selectedMedia =
            body.media_ids.length > 0
                ? await tx
                      .select({ id: Media.id, post_id: Media.post_id })
                      .from(Media)
                      .where(and(inArray(Media.id, body.media_ids), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                : [];

        if (selectedMedia.length !== body.media_ids.length) {
            throw new Error("One or more media items were not found or not active");
        }

        const attachedMediaIds = getAttachedMediaIds(selectedMedia);
        if (attachedMediaIds.length > 0) {
            throw new Error("Only independent media can be moved directly");
        }

        const sourceAuthorIds = uniqueIds(selectedPosts.map((p) => p.author_id).filter((id): id is string => !!id));

        const sourceAuthors =
            sourceAuthorIds.length > 0
                ? await tx
                      .select()
                      .from(Author)
                      .where(and(inArray(Author.id, sourceAuthorIds), eq(Author.delete_status, DeleteStatus.ACTIVE)))
                : [];

        // Match or clone authors in target library
        const authorMap = new Map<string, string>();
        const avatarCopyJobs: Array<{ sourceAuthorId: string; targetAuthorId: string }> = [];

        if (sourceAuthors.length > 0) {
            const targetAuthors = await tx
                .select()
                .from(Author)
                .where(and(eq(Author.library_id, body.target_library_id), eq(Author.delete_status, DeleteStatus.ACTIVE)));

            for (const sa of sourceAuthors) {
                const matched = targetAuthors.find((ta) => ta.platform === sa.platform && ta.eid === sa.eid);
                if (matched) {
                    authorMap.set(sa.id, matched.id);
                } else {
                    const newAuthorId = crypto.randomUUID();
                    await tx.insert(Author).values({
                        id: newAuthorId,
                        library_id: body.target_library_id,
                        eid: sa.eid,
                        short_eid: sa.short_eid,
                        nickname: sa.nickname,
                        signature: sa.signature,
                        platform: sa.platform,
                        avatar_file_id: null,
                        avatar_thumb_file_id: null,
                        delete_status: DeleteStatus.ACTIVE,
                    });
                    authorMap.set(sa.id, newAuthorId);
                    if (sa.avatar_file_id || sa.avatar_thumb_file_id) {
                        avatarCopyJobs.push({
                            sourceAuthorId: sa.id,
                            targetAuthorId: newAuthorId,
                        });
                    }
                }
            }
        }

        // 1. Gather all tags associated with the posts and media
        const postTags =
            body.post_ids.length > 0
                ? await tx
                      .select({
                          post_id: PostTag.post_id,
                          tag_name: Tag.name,
                          tag_normalized: Tag.normalized_name,
                          tag_color: Tag.color,
                          tag_status: Tag.status,
                          tag_source: Tag.source,
                          tag_source_field: Tag.source_field,
                      })
                      .from(PostTag)
                      .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                      .where(inArray(PostTag.post_id, body.post_ids))
                : [];

        // Resolve all media items being moved (both direct and post-attached)
        const postMediaRows =
            body.post_ids.length > 0 ? await tx.select({ id: Media.id }).from(Media).where(inArray(Media.post_id, body.post_ids)) : [];
        const postMediaIds = postMediaRows.map((m) => m.id);
        const allMovedMediaIds = uniqueIds([...body.media_ids, ...postMediaIds]);

        const mediaTags =
            allMovedMediaIds.length > 0
                ? await tx
                      .select({
                          media_id: MediaTag.media_id,
                          tag_name: Tag.name,
                          tag_normalized: Tag.normalized_name,
                          tag_color: Tag.color,
                          tag_status: Tag.status,
                          tag_source: Tag.source,
                          tag_source_field: Tag.source_field,
                      })
                      .from(MediaTag)
                      .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
                      .where(inArray(MediaTag.media_id, allMovedMediaIds))
                : [];

        // 2. Determine target tags that need to be queried/upserted in the target library
        const uniqueTagsMap = new Map<
            string,
            {
                name: string;
                color: string | null;
                status: any;
                source: any;
                sourceField: string | null;
            }
        >();

        for (const pt of postTags) {
            if (!uniqueTagsMap.has(pt.tag_normalized)) {
                uniqueTagsMap.set(pt.tag_normalized, {
                    name: pt.tag_name,
                    color: pt.tag_color,
                    status: pt.tag_status,
                    source: pt.tag_source,
                    sourceField: pt.tag_source_field,
                });
            }
        }
        for (const mt of mediaTags) {
            if (!uniqueTagsMap.has(mt.tag_normalized)) {
                uniqueTagsMap.set(mt.tag_normalized, {
                    name: mt.tag_name,
                    color: mt.tag_color,
                    status: mt.tag_status,
                    source: mt.tag_source,
                    sourceField: mt.tag_source_field,
                });
            }
        }

        const targetTagMap = new Map<string, string>(); // normalized_name -> targetTagId
        if (uniqueTagsMap.size > 0) {
            // Fetch target library existing tags
            const existingTargetTags = await tx.select().from(Tag).where(eq(Tag.library_id, body.target_library_id));

            for (const [normName, info] of uniqueTagsMap.entries()) {
                const matched = existingTargetTags.find((t) => t.normalized_name === normName);
                if (matched) {
                    targetTagMap.set(normName, matched.id);
                } else {
                    // Create in target library
                    const inserted = await tx
                        .insert(Tag)
                        .values({
                            name: info.name,
                            normalized_name: normName,
                            color: info.color,
                            library_id: body.target_library_id,
                            status: info.status,
                            source: info.source,
                            source_field: info.sourceField,
                        })
                        .returning({ id: Tag.id });
                    if (inserted[0]) {
                        targetTagMap.set(normName, inserted[0].id);
                    }
                }
            }
        }

        // 3. Move posts and media items
        let posts = 0;
        let media = 0;
        let postMedia = 0;

        if (body.post_ids.length > 0) {
            for (const post of selectedPosts) {
                const targetAuthorId = post.author_id ? authorMap.get(post.author_id) : null;
                await tx
                    .update(Post)
                    .set({
                        library_id: body.target_library_id,
                        author_id: targetAuthorId || null,
                    })
                    .where(eq(Post.id, post.id));
            }
            posts = selectedPosts.length;

            const updatedPostMedia = await tx
                .update(Media)
                .set({ library_id: body.target_library_id })
                .where(inArray(Media.post_id, body.post_ids))
                .returning({ id: Media.id });
            postMedia = updatedPostMedia.length;
        }

        if (body.media_ids.length > 0) {
            const updatedMedia = await tx
                .update(Media)
                .set({ library_id: body.target_library_id })
                .where(and(inArray(Media.id, body.media_ids), isNull(Media.post_id)))
                .returning({ id: Media.id });
            media = updatedMedia.length;
        }

        // 4. Re-link tag relations
        if (postTags.length > 0) {
            await tx.delete(PostTag).where(inArray(PostTag.post_id, body.post_ids));
            const newPostTags = postTags
                .map((pt) => {
                    const targetId = targetTagMap.get(pt.tag_normalized);
                    return targetId ? { post_id: pt.post_id, tag_id: targetId } : null;
                })
                .filter((pt): pt is { post_id: string; tag_id: string } => !!pt);
            if (newPostTags.length > 0) {
                await tx.insert(PostTag).values(newPostTags);
            }
        }

        if (mediaTags.length > 0) {
            await tx.delete(MediaTag).where(inArray(MediaTag.media_id, allMovedMediaIds));
            const newMediaTags = mediaTags
                .map((mt) => {
                    const targetId = targetTagMap.get(mt.tag_normalized);
                    return targetId ? { media_id: mt.media_id, tag_id: targetId } : null;
                })
                .filter((mt): mt is { media_id: string; tag_id: string } => !!mt);
            if (newMediaTags.length > 0) {
                await tx.insert(MediaTag).values(newMediaTags);
            }
        }

        return { posts, media, post_media: postMedia, avatarCopyJobs };
    });

    // Trigger background DB task to copy avatars asynchronously outside of the long DB transaction
    if (moved.avatarCopyJobs.length > 0) {
        const uniqueAvatarCopyJobs = Array.from(
            new Map(moved.avatarCopyJobs.map((job) => [`${job.sourceAuthorId}:${job.targetAuthorId}`, job])).values(),
        );
        const unitSpecs = uniqueAvatarCopyJobs.map((job) => ({
            unitKey: `avatar_copy:${job.sourceAuthorId}:${job.targetAuthorId}`,
            kind: AsyncTaskUnitKind.AVATAR_COPY,
            subjectType: AsyncSubjectType.AUTHOR,
            subjectId: job.targetAuthorId,
            inputSnapshot: { sourceAuthorId: job.sourceAuthorId, targetAuthorId: job.targetAuthorId },
        }));

        await JobManager.enqueueTaskWithUnits(
            {
                type: AsyncTaskType.AVATAR_COPY,
                ownerId: user.id,
                inputSnapshot: { count: uniqueAvatarCopyJobs.length },
            },
            unitSpecs,
        );
    }

    return c.json(
        success(Code.SUCCESS, {
            posts: moved.posts,
            media: moved.media,
            post_media: moved.post_media,
        }),
    );
});

// GET Library AI Config
router.get("/:id/ai-config", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");

    const libraryRows = await db.select().from(Library).where(eq(Library.id, id)).limit(1);
    const library = libraryRows[0];

    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    return c.json(
        success(Code.SUCCESS, {
            ai_provider: library.ai_provider,
            openai_api_key: maskKey(library.openai_api_key),
            openai_base_url: library.openai_base_url,
            openai_model_embedding_text: library.openai_model_embedding_text,
            openai_model_embedding_text_map_to: library.openai_model_embedding_text_map_to,
            openai_model_embedding_image: library.openai_model_embedding_image,
            openai_model_embedding_image_map_to: library.openai_model_embedding_image_map_to,
            openai_model_describe_image: library.openai_model_describe_image,
            openai_model_describe_image_map_to: library.openai_model_describe_image_map_to,
            gemini_api_key: maskKey(library.gemini_api_key),
            gemini_base_url: library.gemini_base_url,
        }),
    );
});

// POST Library AI Config
router.post("/:id/ai-config", requireAuth, validate("param", LibraryIdParamSchema), validate("json", LibraryAiConfigSchema), async (c) => {
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");

    const libraryRows = await db.select().from(Library).where(eq(Library.id, id)).limit(1);
    const library = libraryRows[0];

    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    let geminiApiKey = body.gemini_api_key;
    if (geminiApiKey && geminiApiKey.includes("...")) {
        geminiApiKey = library.gemini_api_key;
    }

    let openaiApiKey = body.openai_api_key;
    if (openaiApiKey && openaiApiKey.includes("...")) {
        openaiApiKey = library.openai_api_key;
    }

    await db
        .update(Library)
        .set({
            ai_provider: body.ai_provider,
            openai_api_key: openaiApiKey,
            openai_base_url: body.openai_base_url,
            openai_model_embedding_text: body.openai_model_embedding_text,
            openai_model_embedding_text_map_to: body.openai_model_embedding_text_map_to,
            openai_model_embedding_image: body.openai_model_embedding_image,
            openai_model_embedding_image_map_to: body.openai_model_embedding_image_map_to,
            openai_model_describe_image: body.openai_model_describe_image,
            openai_model_describe_image_map_to: body.openai_model_describe_image_map_to,
            gemini_api_key: geminiApiKey,
            gemini_base_url: body.gemini_base_url,
            update_time: sql`now()`,
        })
        .where(eq(Library.id, id));

    return c.json(success(Code.SUCCESS, null, "Library AI configuration updated successfully"));
});

router.post(
    "/:id/cover-jobs",
    requireAuth,
    validate("param", LibraryIdParamSchema),
    validate("json", LibraryCoverJobsBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const { id } = c.req.valid("param");
        const body = c.req.valid("json");

        const library = await db.query.Library.findFirst({
            where: { id },
        });
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
        if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

        const sourceType = body.type === "MANUAL" ? "MANUAL" : "RECONCILE";
        const qualities = body.qualities || (library.cover_qualities as Quality[]) || [Quality.LOW, Quality.MEDIUM];

        const task = await JobManager.createTask({
            type: sourceType === "MANUAL" ? AsyncTaskType.COVER_BATCH : AsyncTaskType.COVER_RECONCILE,
            libraryId: library.id,
            ownerId: user.id,
            inputSnapshot: {
                source_type: sourceType,
                qualities,
                media_ids: body.media_ids || null,
                force: body.force ?? false,
            },
            configVersion: library.cover_config_version,
        });

        return c.json(
            success(Code.SUCCESS, {
                task_id: task.id,
                type: task.type,
                status: task.status,
                config_version: task.config_version,
                active_task: task,
            }),
            202,
        );
    },
);

router.get("/:id/cover-jobs/active", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const { id } = c.req.valid("param");

    const library = await db.query.Library.findFirst({
        where: { id: id },
    });
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

    const activeTasks = await db
        .select()
        .from(AsyncTask)
        .where(
            and(
                eq(AsyncTask.library_id, id),
                eq(AsyncTask.type, AsyncTaskType.COVER_RECONCILE),
                eq(AsyncTask.config_version, library.cover_config_version),
            ),
        )
        .orderBy(desc(AsyncTask.create_time))
        .limit(1);

    const activeTask = activeTasks[0];

    const isRunning = activeTask && (activeTask.status === AsyncTaskStatus.DISCOVERING || activeTask.status === AsyncTaskStatus.RUNNING);
    const reconcileStatus = isRunning ? "IN_PROGRESS" : "IDLE";

    return c.json(
        success(Code.SUCCESS, {
            library_id: library.id,
            reconcile_status: reconcileStatus,
            active_task: activeTask || null,
        }),
    );
});

router.get("/:id/cover-config", requireAuth, validate("param", LibraryIdParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

    const { id } = c.req.valid("param");

    const library = await db.query.Library.findFirst({
        where: { id: id },
    });
    if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

    const rawQualities = library.cover_qualities;
    const qualities = Array.isArray(rawQualities) ? rawQualities : [Quality.LOW, Quality.MEDIUM];

    return c.json(
        success(Code.SUCCESS, {
            library_id: library.id,
            qualities,
            config_version: library.cover_config_version,
        }),
    );
});

router.put(
    "/:id/cover-config",
    requireAuth,
    validate("param", LibraryIdParamSchema),
    validate("json", LibraryCoverConfigBodySchema),
    async (c) => {
        const user = c.get("user");
        if (!user) return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);

        const { id } = c.req.valid("param");
        const body = c.req.valid("json");

        const library = await db.query.Library.findFirst({
            where: { id },
        });
        if (!library) return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
        if (library.owner_id !== user.id) return c.json(error(Code.UNAUTHORIZED, "Unauthorized access to library"), 403);

        // Check whether the new qualities are different from the old ones
        const oldQualities = (library.cover_qualities as Quality[]) || [];
        const isSame =
            oldQualities.length === body.qualities.length &&
            new Set(oldQualities).size === new Set(body.qualities).size &&
            oldQualities.every((quality) => body.qualities.includes(quality));
        const isChanged = !isSame;

        let newVersion = library.cover_config_version;
        let createdTask: typeof AsyncTask.$inferSelect | null = null;

        if (isChanged) {
            newVersion += 1;
            const now = Temporal.Now.instant();

            await db
                .update(Library)
                .set({
                    cover_qualities: body.qualities,
                    cover_config_version: newVersion,
                    update_time: now,
                })
                .where(eq(Library.id, id));

            createdTask = await JobManager.createTask({
                type: AsyncTaskType.COVER_RECONCILE,
                libraryId: id,
                ownerId: user.id,
                inputSnapshot: {
                    source_type: "RECONCILE",
                    qualities: body.qualities,
                },
                configVersion: newVersion,
            });
        }

        return c.json(
            success(Code.SUCCESS, {
                library_id: id,
                qualities: body.qualities,
                config_version: newVersion,
                is_changed: isChanged,
                active_task: createdTask || null,
            }),
        );
    },
);

export default router;
