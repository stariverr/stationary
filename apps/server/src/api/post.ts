import { Context, Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { error, success } from "@/lib/response";
import { Code } from "@/lib/code";
import { requireAuth } from "@/lib/auth/middleware";
import {
    Media,
    Track,
    Post,
    File as DbFile,
    DeleteStatus,
    PostSource,
    TrackType,
    TrackPurpose,
    Author,
    SyncStatus,
    MediaType,
    PostTag,
    Tag,
    TagStatus,
    Library,
    DraftFile,
    DraftFileStatus,
} from "@/db/schema";
import { and, eq, ilike, SQL, count, asc, desc, sql, isNull, inArray, lte, exists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { PostService, replacePostTagsTx } from "@/services/post";
import { replaceMediaTagsTx } from "@/services/media";
import { buildCdnUrl, buildImagePreviewCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp, FormTimestampSchema, nowDbTimestamp } from "@/lib/utils/time";
import { Quality } from "@/lib/types";
import { v7 as uuidv7 } from "uuid";
import { TrackService } from "@/services/track";
import { consumeDraftFile, DraftFileUnavailableError } from "@/services/draft-file";
import {
    assignTrackPriorities,
    validateDraftMediaGroups,
    validateDraftTrackFileTypes,
    MediaDraftSchema,
} from "@/lib/validation/media-composition";
import { validate } from "@/lib/validation/validator";
import { formatListPreviews, getMediaCoversMap, getMediaTracks, PreviewItem } from "@/lib/utils/media_mapper";

const router = new Hono();
const activePostFilter = and(eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time));
const activeMediaFilter = and(eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

export const PostListRequestBodySchema = z.object({
    library_id: z.uuid(),
    page: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1, "Page must be 1 or greater.").optional(),
    ),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(10, "Count must be 10 or greater.").lte(100, "Count must be 100 or less.").optional(),
    ),
    keyword: z.string().optional(),
    source: z.enum(PostSource).optional(),
    sort_by: z.enum(["import_time", "published_time"]).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
    author_ids: z.string().optional(),
    media_type: z.enum(MediaType).optional(),
    tag_ids: z.string().optional(),
});

// Post List - Cover-only media hydration (no primary content track queries)
router.get("/list", requireAuth, validate("query", PostListRequestBodySchema), async (c) => {
    const query = c.req.valid("query");
    const page = query.page ?? 1;
    let pageSize = query.count ?? 20;
    if (pageSize > 100) {
        pageSize = 100;
    }
    const offset = (page - 1) * pageSize;

    const { keyword, source, sort_by, sort_order, author_ids: authorIdsStr, media_type: mediaType, tag_ids: tagIdsStr, library_id } = query;
    const sortBy = sort_by ?? "published_time";
    const sortOrder = sort_order ?? "desc";

    const where: SQL[] = [eq(Post.library_id, library_id)];

    if (keyword) {
        where.push(ilike(Post.title, `%${keyword}%`));
    }
    if (source) {
        where.push(eq(Post.source, source));
    }
    if (authorIdsStr) {
        const authorIds = authorIdsStr.split(",").filter((id) => id.trim().length > 0);
        if (authorIds.length > 0) {
            where.push(inArray(Post.author_id, authorIds));
        }
    }
    if (tagIdsStr) {
        const tagIds = tagIdsStr.split(",").filter((id) => id.trim().length > 0);
        if (tagIds.length > 0) {
            where.push(
                exists(
                    db
                        .select()
                        .from(PostTag)
                        .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                        .where(and(eq(PostTag.post_id, Post.id), or(inArray(Tag.id, tagIds), inArray(Tag.canonical_tag_id, tagIds)))),
                ),
            );
        }
    }
    if (mediaType) {
        where.push(
            exists(
                db
                    .select()
                    .from(Media)
                    .where(
                        and(
                            eq(Media.post_id, Post.id),
                            eq(Media.type, mediaType),
                            eq(Media.delete_status, DeleteStatus.ACTIVE),
                            isNull(Media.recycle_time),
                        ),
                    ),
            ),
        );
    }

    const orderColumn = sortBy === "import_time" ? Post.create_time : sql`coalesce(${Post.published_time}, ${Post.create_time})`;
    const orderByExpr = sortOrder === "asc" ? asc(orderColumn) : desc(orderColumn);

    const rawPosts = await db
        .select({
            id: Post.id,
            library_id: Post.library_id,
            eid: Post.eid,
            title: Post.title,
            source: Post.source,
            author_name: Post.author_name,
            create_time: Post.create_time,
            published_time: Post.published_time,
            sync_status: Post.sync_status,
            last_error: Post.last_error,
            author_avatar_bucket: DbFile.bucket,
            author_avatar_path: DbFile.path,
        })
        .from(Post)
        .leftJoin(Author, eq(Post.author_id, Author.id))
        .leftJoin(DbFile, eq(Author.avatar_file_id, DbFile.id))
        .where(and(activePostFilter, ...where))
        .orderBy(orderByExpr)
        .limit(pageSize)
        .offset(offset);

    const postIds = rawPosts.map((p) => p.id);

    type MediaItem = Pick<typeof Media.$inferSelect, "id" | "post_id" | "type" | "sort_order"> & {
        covers: PreviewItem[];
        videos: null;
        audios: null;
    };
    const mediaByPostId = new Map<string, MediaItem[]>();

    if (postIds.length > 0) {
        const mediaRows = await db
            .select({
                id: Media.id,
                post_id: Media.post_id,
                type: Media.type,
                sort_order: Media.sort_order,
            })
            .from(Media)
            .where(and(inArray(Media.post_id, postIds), lte(Media.sort_order, 3), activeMediaFilter))
            .orderBy(asc(Media.sort_order));

        const allMediaIds = mediaRows.map((mr) => mr.id);
        const coversByMediaId = await getMediaCoversMap(allMediaIds);

        for (const row of mediaRows) {
            if (!row.post_id) continue;

            const covers = coversByMediaId.get(row.id) || [];
            const previews = formatListPreviews(covers);

            let mediaList = mediaByPostId.get(row.post_id);
            if (!mediaList) {
                mediaList = [];
                mediaByPostId.set(row.post_id, mediaList);
            }

            mediaList.push({
                id: row.id,
                post_id: row.post_id,
                type: row.type,
                sort_order: row.sort_order,
                covers: previews.covers,
                videos: previews.videos,
                audios: previews.audios,
            });
        }
    }

    const postTagsMap = new Map<string, string[]>();
    if (postIds.length > 0) {
        const allTags = await db
            .select({
                post_id: PostTag.post_id,
                tag_name: Tag.name,
            })
            .from(PostTag)
            .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
            .where(and(inArray(PostTag.post_id, postIds), eq(Tag.status, TagStatus.ACTIVE)))
            .orderBy(asc(PostTag.id));

        for (const row of allTags) {
            let tags = postTagsMap.get(row.post_id);
            if (!tags) {
                tags = [];
                postTagsMap.set(row.post_id, tags);
            }
            tags.push(row.tag_name);
        }
    }

    const posts = rawPosts.map((post) => {
        const postMedia = mediaByPostId.get(post.id) || [];
        const type: "MULTI_MEDIA" | "TEXT" = postMedia.length > 0 ? "MULTI_MEDIA" : "TEXT";
        const postTags = postTagsMap.get(post.id) || [];
        return {
            id: post.id,
            library_id: post.library_id,
            type: type,
            title: post.title,
            source: post.source,
            tags: postTags,
            author_name: post.author_name,
            author_avatar_url: buildImagePreviewCdnUrl(post.author_avatar_bucket, post.author_avatar_path, Quality.LOW),
            create_time: toIsoTimestamp(post.create_time),
            published_time: toIsoTimestamp(post.published_time),
            sync_status: post.sync_status,
            last_error: post.last_error,
            media: postMedia,
        };
    });

    const total = await db
        .select({ total: count() })
        .from(Post)
        .where(and(activePostFilter, ...where));

    return c.json(
        success(Code.SUCCESS, {
            list: posts,
            total: total[0].total,
        }),
    );
});

const PostAuthorsQuerySchema = z.object({
    library_id: z.uuid(),
    keyword: z.string().optional(),
    author_ids: z.string().optional(),
    platform: z.enum(PostSource).optional(),
});

router.get("/authors", requireAuth, validate("query", PostAuthorsQuerySchema), async (c) => {
    const { library_id, keyword, author_ids, platform } = c.req.valid("query");

    const whereClause: SQL[] = [
        eq(Author.library_id, library_id),
        eq(Post.library_id, library_id),
        eq(Post.delete_status, DeleteStatus.ACTIVE),
        isNull(Post.recycle_time),
        eq(Author.delete_status, DeleteStatus.ACTIVE),
    ];

    if (keyword) {
        whereClause.push(ilike(Author.nickname, `%${keyword}%`));
    }

    if (author_ids) {
        const ids = author_ids.split(",").filter((id) => id.trim().length > 0);
        if (ids.length > 0) {
            whereClause.push(inArray(Author.id, ids));
        }
    }

    if (platform) {
        whereClause.push(eq(Author.platform, platform));
    }

    const authorList = await db
        .select({
            id: Author.id,
            nickname: Author.nickname,
            platform: Author.platform,
            avatar_file_id: Author.avatar_file_id,
            avatar_bucket: DbFile.bucket,
            avatar_path: DbFile.path,
        })
        .from(Author)
        .innerJoin(Post, eq(Post.author_id, Author.id))
        .leftJoin(DbFile, eq(Author.avatar_file_id, DbFile.id))
        .where(and(...whereClause))
        .groupBy(Author.id, Author.nickname, Author.platform, Author.avatar_file_id, DbFile.bucket, DbFile.path)
        .orderBy(asc(Author.nickname))
        .limit(50);

    const result = authorList.map((auth) => ({
        id: auth.id,
        nickname: auth.nickname,
        platform: auth.platform,
        avatar_url: auth.avatar_path ? buildImagePreviewCdnUrl(auth.avatar_bucket, auth.avatar_path, Quality.LOW) : null,
    }));

    return c.json(success(Code.SUCCESS, result));
});

const PostDetailRequestPathParamSchema = z.object({
    id: z.uuid(),
});

export const PostDetailResponseBodySchema = z.object({
    id: z.uuid().optional(),
    library_id: z.uuid().optional(),
    source: z.string().optional(),
    eid: z.string().optional(),
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    author_name: z.string().nullable().optional(),
    author_avatar_url: z.string().nullable().optional(),
    author_external_id: z.string().nullable().optional(),
    create_time: z.string().optional(),
    published_time: z.string().nullable().optional(),
    media_count: z.number().optional(),
    type: z.enum(["TEXT", "MULTI_MEDIA"]).optional(),
    url: z.string().nullable().optional(),
    sync_status: z.string().optional(),
    last_error: z.string().nullable().optional(),
    media: z
        .array(
            z.object({
                id: z.uuid(),
                eid: z.string().optional(),
                post_id: z.uuid().nullable().optional(),
                source: z.string().optional(),
                title: z.string().nullable().optional(),
                description: z.string().nullable().optional(),
                type: z.string().optional(),
                sort_order: z.number().optional(),
                create_time: z.string().optional(),
                published_time: z.string().nullable().optional(),
                sync_status: z.string().optional(),
                last_error: z.string().nullable().optional(),
                ai_status: z.string().optional(),
                ai_error: z.string().nullable().optional(),
                url: z.string().nullable().optional(),
                cover_url: z.string().nullable().optional(),
                width: z.number().nullable().optional(),
                height: z.number().nullable().optional(),
                tracks: z.array(
                    z.object({
                        id: z.string().optional(),
                        url: z.string(),
                        type: z.string(),
                        purpose: z.string(),
                        is_original: z.boolean(),
                        quality: z.string(),
                        priority: z.number(),
                        metadata: z.record(z.string(), z.any()),
                    }),
                ),
            }),
        )
        .optional(),
});

router.get("/detail/:id", requireAuth, validate("param", PostDetailRequestPathParamSchema), async (c) => {
    const id = c.req.valid("param").id;
    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const postData = access.post!;

    const authorAvatarFile = alias(DbFile, "author_avatar_file");
    const avatarRows = await db
        .select({
            author_avatar_bucket: authorAvatarFile.bucket,
            author_avatar_path: authorAvatarFile.path,
        })
        .from(Post)
        .leftJoin(Author, eq(Post.author_id, Author.id))
        .leftJoin(authorAvatarFile, eq(Author.avatar_file_id, authorAvatarFile.id))
        .where(eq(Post.id, id))
        .limit(1);

    const avatar = avatarRows[0];

    const postTagsList = await db
        .select({ name: Tag.name })
        .from(PostTag)
        .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
        .where(and(eq(PostTag.post_id, id), eq(Tag.status, TagStatus.ACTIVE)))
        .orderBy(asc(PostTag.id));
    const postTags = postTagsList.map((pt) => pt.name);

    const result: z.infer<typeof PostDetailResponseBodySchema> = {
        id: postData.id,
        library_id: postData.library_id,
        source: postData.source,
        eid: postData.eid,
        title: postData.title,
        description: postData.description,
        tags: postTags,
        author_name: postData.author_name,
        author_avatar_url: avatar ? buildImagePreviewCdnUrl(avatar.author_avatar_bucket, avatar.author_avatar_path, Quality.LOW) : null,
        author_external_id: postData.author_external_id,
        create_time: toIsoTimestamp(postData.create_time) ?? undefined,
        published_time: toIsoTimestamp(postData.published_time),
        media_count: postData.media_count,
        type: (postData.media_count ?? 0) > 0 ? "MULTI_MEDIA" : "TEXT",
        sync_status: postData.sync_status,
        last_error: postData.last_error,
        url: postData.url,
    };

    return c.json(success(Code.SUCCESS, result));
});

const PostMediaListQuerySchema = z.object({
    page: z.preprocess((val) => (val === undefined ? 1 : Number(val)), z.number().int().positive().default(1)),
    limit: z.preprocess((val) => (val === undefined ? 50 : Number(val)), z.number().int().positive().default(50)),
    keyword: z.string().optional(),
    type: z.enum([MediaType.IMAGE, MediaType.VIDEO, MediaType.LIVE_PHOTO, MediaType.AUDIO, MediaType.PDF]).optional(),
});

const PostMediaListParamSchema = z.object({
    id: z.uuid(),
});

// Detail route for media under a post
router.get(
    "/:id/media",
    requireAuth,
    validate("param", PostMediaListParamSchema),
    validate("query", PostMediaListQuerySchema),
    async (c) => {
        const postId = c.req.valid("param").id;
        const { page, limit, keyword, type } = c.req.valid("query");

        const access = await checkPostAccess(c, postId);
        if (access.errorResponse) return access.errorResponse;

        const conditions: SQL[] = [eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)];

        if (type) {
            conditions.push(eq(Media.type, type));
        }
        if (keyword) {
            conditions.push(ilike(Media.title, `%${keyword}%`));
        }

        const totalResult = await db
            .select({ count: count() })
            .from(Media)
            .where(and(...conditions));
        const total = totalResult[0]?.count ?? 0;

        const offset = (page - 1) * limit;

        const finalRows = await db
            .select()
            .from(Media)
            .where(and(...conditions))
            .orderBy(asc(Media.sort_order), asc(Media.id))
            .limit(limit)
            .offset(offset);

        const totalPages = Math.ceil(total / limit);

        const mediaList = await Promise.all(
            finalRows.map(async (m, i) => {
                const files = await getMediaTracks(m.id);
                const sortedFiles = [...files].sort((a, b) => a.priority - b.priority);

                const tracks = sortedFiles
                    .filter((f) => f.file_path && f.file_bucket)
                    .map((f) => ({
                        id: f.track_id,
                        file_id: f.file_id || "",
                        url: buildCdnUrl(f.file_bucket!, f.file_path!) || "",
                        type: f.type,
                        purpose: f.purpose,
                        is_original: f.is_original,
                        quality: f.quality,
                        priority: f.priority,
                        metadata: f.metadata || {},
                        variant_key: f.variant_key,
                        is_default: f.is_default,
                        display_name: f.display_name,
                        language: f.language,
                        codec: f.codec,
                    }));

                const coverTrack = tracks.find((t) => t.purpose === TrackPurpose.COVER);

                return {
                    id: m.id,
                    type: m.type,
                    title: m.title,
                    sort_order: m.sort_order,
                    position: offset + i,
                    cover_url: coverTrack?.url ?? "",
                    tracks,
                };
            }),
        );

        return c.json(
            success(Code.SUCCESS, {
                list: mediaList,
                page,
                limit,
                total,
                total_pages: totalPages,
            }),
        );
    },
);

router.post("/trash/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "post id is required"), 400);
    }

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await RecycleService.recyclePost(id);
    if (result.postUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Post not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/restore/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "post id is required"), 400);
    }

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await RecycleService.restorePost(id);
    if (result.postUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Post not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/delete/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "post id is required"), 400);
    }

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await DeleteService.deletePost(id);
    if (result.postUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Post not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

async function checkPostAccess(
    c: Context,
    postId: string,
): Promise<{ post: typeof Post.$inferSelect; errorResponse: null } | { post: null; errorResponse: any }> {
    const user = c.get("user");
    if (!user) {
        return {
            post: null,
            errorResponse: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401),
        };
    }

    const postRows = await db.select().from(Post).where(eq(Post.id, postId)).limit(1);
    const post = postRows[0];

    if (!post || post.delete_status !== DeleteStatus.ACTIVE || post.recycle_time !== null) {
        return {
            post: null,
            errorResponse: c.json(error(Code.NOT_FOUND, "Post not found or is in recycle bin"), 404),
        };
    }

    const libraryList = await db.select().from(Library).where(eq(Library.id, post.library_id)).limit(1);
    const library = libraryList[0];

    if (!library || library.owner_id !== user.id) {
        return {
            post: null,
            errorResponse: c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403),
        };
    }

    const apiToken = c.get("apiToken");
    if (apiToken && apiToken.library_id && apiToken.library_id !== post.library_id) {
        return {
            post: null,
            errorResponse: c.json(error(Code.FORBIDDEN, "API token scope restricted to another library"), 403),
        };
    }

    return { post, errorResponse: null };
}

const PostUpdateInfoSchema = z
    .object({
        title: z.string().min(1, "Title cannot be empty").optional(),
        description: z.string().optional(),
        published_time: FormTimestampSchema,
        url: z.url().or(z.literal("")).nullable().optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: "At least one field must be provided for update",
    });

router.post("/update-info/:id", requireAuth, validate("json", PostUpdateInfoSchema), async (c) => {
    const id = c.req.param("id")!;
    const body = c.req.valid("json");

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const updated = await PostService.updateInfo(id, body);
    return c.json(success(Code.SUCCESS, updated));
});

const PostReplaceTagsSchema = z.object({
    tag_ids: z.array(z.uuid()),
});

router.post("/:id/tags/replace", requireAuth, validate("json", PostReplaceTagsSchema), async (c) => {
    const id = c.req.param("id")!;
    const { tag_ids } = c.req.valid("json");

    const access = await checkPostAccess(c, id);
    if (!access.post || access.errorResponse) return access.errorResponse;
    const post = access.post;

    const resolvedTagIds = await PostService.replaceTags(id, post.library_id, tag_ids);
    return c.json(success(Code.SUCCESS, { tag_ids: resolvedTagIds }));
});

const PostAttachMediaSchema = z.object({
    media_ids: z.array(z.uuid()).min(1, "media_ids must contain at least one ID"),
});

router.post("/:id/bind_media", requireAuth, validate("json", PostAttachMediaSchema), async (c) => {
    const id = c.req.param("id")!;
    const { media_ids } = c.req.valid("json");

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const post = access.post!;

    const result = await PostService.bindMedia(id, post.library_id, media_ids);

    if ("error" in result) {
        return c.json(error(Code.INVALID_PARAMETER, result.error || "Attach failed"), 400);
    }

    return c.json(success(Code.SUCCESS, result));
});

const PostReorderMediaSchema = z.object({
    media_ids: z.array(z.uuid()).min(1, "media_ids must contain at least one ID"),
});

router.post("/:id/media/reorder", requireAuth, validate("json", PostReorderMediaSchema), async (c) => {
    const id = c.req.param("id")!;
    const { media_ids } = c.req.valid("json");

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await PostService.reorderMedia(id, media_ids);

    if ("error" in result) {
        return c.json(error(Code.INVALID_PARAMETER, result.error || "Reorder failed"), 400);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/:id/media/:mediaId/remove", requireAuth, async (c) => {
    const id = c.req.param("id")!;
    const mediaId = c.req.param("mediaId")!;

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await PostService.unbindMedia(id, mediaId);

    if ("error" in result) {
        return c.json(error(Code.INVALID_PARAMETER, result.error || "Remove failed"), 400);
    }

    return c.json(success(Code.SUCCESS, result));
});

const CreatePostMediaItemSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("existing"),
        media_id: z.uuid(),
    }),
    z.object({
        kind: z.literal("draft"),
        draft: MediaDraftSchema,
    }),
]);

const CreatePostSchema = z.object({
    library_id: z.uuid(),
    title: z.string().min(1, "Title is required"),
    description: z.string().optional().default(""),
    tag_ids: z.array(z.uuid()).optional().default([]),
    media_items: z.array(CreatePostMediaItemSchema).optional(),
});

router.post("/create", requireAuth, validate("json", CreatePostSchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const libraryList = await db.select().from(Library).where(eq(Library.id, body.library_id)).limit(1);
    const library = libraryList[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403);
    }

    const mediaIds = body.media_items?.filter((item) => item.kind === "existing").map((item) => item.media_id) || [];
    const mediaDrafts = body.media_items?.filter((item) => item.kind === "draft").map((item) => item.draft) || [];

    if (mediaDrafts.length > 0) {
        const compositionError = validateDraftMediaGroups(mediaDrafts);
        if (compositionError) {
            return c.json(error(Code.INVALID_PARAMETER, compositionError), 400);
        }
    }

    if (mediaIds.length > 0) {
        const mediaList = await db
            .select()
            .from(Media)
            .where(and(inArray(Media.id, mediaIds), eq(Media.library_id, body.library_id)));
        if (mediaList.length !== mediaIds.length) {
            return c.json(error(Code.INVALID_PARAMETER, "Some media items are invalid or do not belong to this library"), 400);
        }
        for (const media of mediaList) {
            if (media.post_id !== null) {
                return c.json(error(Code.INVALID_PARAMETER, `Media ${media.title} is already linked to a post`), 400);
            }
        }
    }

    const draftIds = mediaDrafts.flatMap((g) => g.tracks.map((t) => t.draft_file_id));
    if (draftIds.length > 0) {
        const draftRows = await db
            .select({ draft: DraftFile, file: DbFile })
            .from(DraftFile)
            .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
            .where(
                and(
                    eq(DraftFile.library_id, body.library_id),
                    eq(DraftFile.status, DraftFileStatus.DRAFT),
                    inArray(DraftFile.id, draftIds),
                ),
            );

        const activeDraftMap = new Map(
            draftRows.map(({ draft, file }) => [
                draft.id,
                {
                    name: draft.original_name,
                    mime_type: file.mime_type,
                },
            ]),
        );

        if (draftRows.length !== draftIds.length) {
            const missingId = draftIds.find((id) => !activeDraftMap.has(id));
            return c.json(error(Code.INVALID_PARAMETER, `Draft file ${missingId} is invalid or already consumed`), 400);
        }

        const fileTypeError = validateDraftTrackFileTypes(mediaDrafts, activeDraftMap);
        if (fileTypeError) {
            return c.json(error(Code.INVALID_PARAMETER, fileTypeError), 400);
        }
    }

    const postId = uuidv7();

    try {
        await db.transaction(async (tx) => {
            const now = nowDbTimestamp();
            const totalMediaCount = body.media_items && body.media_items.length > 0 ? body.media_items.length : 0;

            await tx.insert(Post).values({
                id: postId,
                eid: postId,
                library_id: body.library_id,
                source: PostSource.UNKNOWN,
                title: body.title,
                description: body.description,
                media_count: totalMediaCount,
                sync_status: SyncStatus.PENDING,
                create_time: now,
                delete_status: DeleteStatus.ACTIVE,
            });

            if (body.tag_ids && body.tag_ids.length > 0) {
                await replacePostTagsTx(tx, postId, body.library_id, body.tag_ids);
            }

            let sortOrder = 0;

            if (body.media_items && body.media_items.length > 0) {
                for (const item of body.media_items) {
                    if (item.kind === "existing") {
                        await tx
                            .update(Media)
                            .set({
                                post_id: postId,
                                sort_order: sortOrder++,
                                update_time: now,
                            })
                            .where(eq(Media.id, item.media_id));
                    } else if (item.kind === "draft") {
                        const mediaDraft = item.draft;
                        const mediaId = uuidv7();

                        await tx.insert(Media).values({
                            id: mediaId,
                            eid: mediaId,
                            post_id: postId,
                            sort_order: sortOrder++,
                            library_id: body.library_id,
                            source: PostSource.UNKNOWN,
                            title: mediaDraft.title,
                            description: mediaDraft.description,
                            type: mediaDraft.type,
                            sync_status: SyncStatus.PENDING,
                            create_time: now,
                        });

                        for (const track of assignTrackPriorities(mediaDraft.tracks)) {
                            const fileId = await consumeDraftFile(tx, track.draft_file_id, body.library_id);

                            await TrackService.upsertTrack(
                                mediaId,
                                {
                                    type: track.type,
                                    purpose: track.purpose,
                                    quality: track.quality,
                                    priority: track.priority,
                                    is_default: track.is_default,
                                    language: track.language || null,
                                },
                                fileId,
                                tx,
                            );
                        }

                        if (mediaDraft.tag_ids && mediaDraft.tag_ids.length > 0) {
                            await replaceMediaTagsTx(tx, mediaId, body.library_id, mediaDraft.tag_ids);
                        }
                    }
                }
            }

            const activeMedias = await tx
                .select({ sync_status: Media.sync_status })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            const allCompleted = activeMedias.every((m) => m.sync_status === SyncStatus.COMPLETED);
            if (allCompleted) {
                await tx
                    .update(Post)
                    .set({
                        sync_status: SyncStatus.COMPLETED,
                        update_time: now,
                    })
                    .where(eq(Post.id, postId));
            }
        });
    } catch (e) {
        if (e instanceof DraftFileUnavailableError) {
            return c.json(error(Code.ALREADY_EXISTS, e.message), 409);
        }
        throw e;
    }

    return c.json(success(Code.SUCCESS, { post_id: postId }));
});

export default router;
