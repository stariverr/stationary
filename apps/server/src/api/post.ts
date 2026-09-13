import { Context, Hono } from "hono";
import { db } from "@/global/db";
import * as v from "valibot";
import { error, success } from "@/lib/response";
import { Code } from "@/lib/code";
import { requireAuth } from "@/lib/auth/middleware";
import { Media, Post, File as DbFile, DeleteStatus, PostSource, Author, MediaType, PostTag, Tag, TagStatus } from "@/db/schema";
import { and, eq, ilike, SQL, count, asc, desc, sql, isNull, inArray, lte, exists, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { PostService } from "@/features/post/post-service";
import { deletePost, restorePost, trashPost } from "@/features/post/lifecycle";
import { assertPostAccess, PostAccessError } from "@/features/post/access";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp, FormTimestampSchema } from "@/lib/utils/time";
import { validate } from "@/lib/validation/validator";
import { MediaService, type PreviewItem } from "@/features/media/queries";
import { CreatePostSchema } from "@/features/post/schema";
import { CreatePostError, createPost } from "@/features/post/create-post";

const router = new Hono();
const activePostFilter = and(eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time));
const activeMediaFilter = and(eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

export const PostListRequestBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    page: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(1, "Page must be 1 or greater."))),
        ),
    ),
    count: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(
                v.pipe(
                    v.number(),
                    v.integer(),
                    v.minValue(10, "Count must be 10 or greater."),
                    v.maxValue(100, "Count must be 100 or less."),
                ),
            ),
        ),
    ),
    keyword: v.optional(v.string()),
    source: v.optional(v.enum(PostSource)),
    sort_by: v.optional(v.picklist(["import_time", "published_time"])),
    sort_order: v.optional(v.picklist(["asc", "desc"])),
    author_ids: v.optional(v.string()),
    media_type: v.optional(v.enum(MediaType)),
    tag_ids: v.optional(v.string()),
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
        videos: PreviewItem[];
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
        const [coversByMediaId, videosByMediaId] = await Promise.all([
            MediaService.getCoversMap(allMediaIds),
            MediaService.getVideosMap(allMediaIds),
        ]);

        for (const row of mediaRows) {
            if (!row.post_id) continue;

            const covers = coversByMediaId.get(row.id) ?? [];
            const videos = videosByMediaId.get(row.id) ?? [];

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
                covers: covers,
                videos: videos,
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
            author_avatar_url: buildCdnUrl(post.author_avatar_bucket, post.author_avatar_path),
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
            total: total[0]?.total ?? 0,
        }),
    );
});

const PostAuthorsQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    keyword: v.optional(v.string()),
    author_ids: v.optional(v.string()),
    platform: v.optional(v.enum(PostSource)),
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
        avatar_url: auth.avatar_path ? buildCdnUrl(auth.avatar_bucket, auth.avatar_path) : null,
    }));

    return c.json(success(Code.SUCCESS, result));
});

const PostDetailRequestPathParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
});

export const PostDetailResponseBodySchema = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    library_id: v.optional(v.pipe(v.string(), v.uuid())),
    source: v.optional(v.string()),
    eid: v.optional(v.string()),
    title: v.optional(v.nullable(v.string())),
    description: v.optional(v.nullable(v.string())),
    tags: v.optional(v.nullable(v.array(v.string()))),
    author_name: v.optional(v.nullable(v.string())),
    author_avatar_url: v.optional(v.nullable(v.string())),
    author_external_id: v.optional(v.nullable(v.string())),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    media_count: v.optional(v.number()),
    type: v.optional(v.picklist(["TEXT", "MULTI_MEDIA"])),
    url: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.string()),
    last_error: v.optional(v.nullable(v.string())),
    media: v.optional(
        v.array(
            v.object({
                id: v.pipe(v.string(), v.uuid()),
                eid: v.optional(v.string()),
                post_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
                source: v.optional(v.string()),
                title: v.optional(v.nullable(v.string())),
                description: v.optional(v.nullable(v.string())),
                type: v.optional(v.string()),
                sort_order: v.optional(v.number()),
                create_time: v.optional(v.string()),
                published_time: v.optional(v.nullable(v.string())),
                sync_status: v.optional(v.string()),
                last_error: v.optional(v.nullable(v.string())),
                ai_status: v.optional(v.string()),
                ai_error: v.optional(v.nullable(v.string())),
                url: v.optional(v.nullable(v.string())),
                cover_url: v.optional(v.nullable(v.string())),
                width: v.optional(v.nullable(v.number())),
                height: v.optional(v.nullable(v.number())),
                tracks: v.array(
                    v.object({
                        id: v.optional(v.string()),
                        url: v.string(),
                        type: v.string(),
                        purpose: v.string(),
                        is_original: v.boolean(),
                        quality: v.string(),
                        priority: v.number(),
                        metadata: v.record(v.string(), v.any()),
                    }),
                ),
            }),
        ),
    ),
});

router.get("/detail/:id", requireAuth, validate("param", PostDetailRequestPathParamSchema), async (c) => {
    const id = c.req.valid("param").id;
    const access = await checkPostAccess(c, id, true);
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

    const result: v.InferOutput<typeof PostDetailResponseBodySchema> = {
        id: postData.id,
        library_id: postData.library_id,
        source: postData.source,
        eid: postData.eid,
        title: postData.title,
        description: postData.description,
        tags: postTags,
        author_name: postData.author_name,
        author_avatar_url: avatar ? buildCdnUrl(avatar.author_avatar_bucket, avatar.author_avatar_path) : null,
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

const PostMediaListQuerySchema = v.object({
    page: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === undefined ? 1 : Number(val))),
            v.pipe(v.number(), v.integer(), v.minValue(1)),
        ),
        1,
    ),
    limit: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === undefined ? 50 : Number(val))),
            v.pipe(v.number(), v.integer(), v.minValue(1)),
        ),
        50,
    ),
    keyword: v.optional(v.string()),
    type: v.optional(v.picklist([MediaType.IMAGE, MediaType.VIDEO, MediaType.LIVE_PHOTO, MediaType.AUDIO, MediaType.PDF])),
});

const PostMediaListParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
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

        const access = await checkPostAccess(c, postId, true);
        if (access.errorResponse) return access.errorResponse;
        const post = access.post!;

        const conditions: SQL[] = [eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)];

        if (post.recycle_time !== null) {
            conditions.push(or(isNull(Media.recycle_time), eq(Media.recycle_time, post.recycle_time))!);
        } else {
            conditions.push(isNull(Media.recycle_time));
        }

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
        const total = totalResult[0].count;

        const offset = (page - 1) * limit;

        const finalRows = await db
            .select()
            .from(Media)
            .where(and(...conditions))
            .orderBy(asc(Media.sort_order), asc(Media.id))
            .limit(limit)
            .offset(offset);

        const totalPages = Math.ceil(total / limit);

        const mediaList = await MediaService.getDetails(finalRows, offset);

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

    const result = await trashPost(id);
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

    const access = await checkPostAccess(c, id, true);
    if (access.errorResponse) return access.errorResponse;

    const result = await restorePost(id);
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

    const access = await checkPostAccess(c, id, true);
    if (access.errorResponse) return access.errorResponse;

    const result = await deletePost(id);
    if (result.postUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Post not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

async function checkPostAccess(
    c: Context,
    postId: string,
    allowRecycled = false,
): Promise<{ post: typeof Post.$inferSelect; errorResponse: null } | { post: null; errorResponse: any }> {
    const user = c.get("user");
    if (!user) {
        return {
            post: null,
            errorResponse: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401),
        };
    }

    try {
        const post = await assertPostAccess(
            postId,
            {
                ownerId: user.id,
                scopedLibraryId: c.get("apiToken")?.library_id,
            },
            { allowRecycled },
        );
        return { post, errorResponse: null };
    } catch (cause) {
        if (!(cause instanceof PostAccessError)) throw cause;

        if (cause.kind === "NOT_FOUND") {
            return { post: null, errorResponse: c.json(error(Code.NOT_FOUND, cause.message), 404) };
        }
        return { post: null, errorResponse: c.json(error(Code.FORBIDDEN, cause.message), 403) };
    }
}

const PostUpdateInfoSchema = v.pipe(
    v.object({
        title: v.optional(v.pipe(v.string(), v.nonEmpty("Title cannot be empty"))),
        description: v.optional(v.string()),
        published_time: FormTimestampSchema,
        url: v.optional(v.nullable(v.union([v.pipe(v.string(), v.url()), v.literal("")]))),
    }),
    v.check((data) => Object.keys(data).length > 0, "At least one field must be provided for update"),
);

router.post("/update-info/:id", requireAuth, validate("json", PostUpdateInfoSchema), async (c) => {
    const id = c.req.param("id")!;
    const body = c.req.valid("json");

    const access = await checkPostAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const updated = await PostService.updateInfo(id, body);
    return c.json(success(Code.SUCCESS, updated));
});

const PostReplaceTagsSchema = v.object({
    tag_ids: v.array(v.pipe(v.string(), v.uuid())),
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

const PostAttachMediaSchema = v.object({
    media_ids: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1, "media_ids must contain at least one ID")),
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

const PostReorderMediaSchema = v.object({
    media_ids: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1, "media_ids must contain at least one ID")),
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

router.post("/create", requireAuth, validate("json", CreatePostSchema), async (c) => {
    const body = c.req.valid("json");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    try {
        const result = await createPost(body, user.id);
        return c.json(success(Code.SUCCESS, { post_id: result.postId }));
    } catch (e) {
        if (!(e instanceof CreatePostError)) throw e;

        if (e.kind === "FORBIDDEN") {
            return c.json(error(Code.FORBIDDEN, e.message), 403);
        }
        if (e.kind === "CONFLICT") {
            return c.json(error(Code.ALREADY_EXISTS, e.message), 409);
        }
        return c.json(error(Code.INVALID_PARAMETER, e.message), 400);
    }
});

export default router;
