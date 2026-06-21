import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { mapMediaToResponse } from "./media";
import { validator } from "hono/validator";
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
    TrackQuality,
    AssetAiMetadata,
    EntityType,
    Author,
    SyncStatus,
    MediaType,
} from "@/db/schema";
import { and, eq, ilike, SQL, count, asc, desc, sql, isNull, inArray, lte, exists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Temporal } from "@js-temporal/polyfill";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

const router = new Hono();
const activePostFilter = and(eq(Post.delete_status, DeleteStatus.ACTIVE), isNull(Post.recycle_time));
const activeMediaFilter = and(eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time));

/** Post List Request Body Schema */
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
    media_type: z.nativeEnum(MediaType).optional(),
});

// Post List
router.get(
    "/list",
    requireAuth,
    validator("query", (value, c) => {
        const parsed = PostListRequestBodySchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid request parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const page = c.req.valid("query").page ?? 1;
        let pageSize = c.req.valid("query").count ?? 20;
        if (pageSize > 100) {
            pageSize = 100;
        }
        const offset = (page - 1) * pageSize;

        const keyword = c.req.valid("query").keyword;
        const source = c.req.valid("query").source;
        const sortBy = c.req.valid("query").sort_by ?? "published_time";
        const sortOrder = c.req.valid("query").sort_order ?? "desc";
        const authorIdsStr = c.req.valid("query").author_ids;
        const mediaType = c.req.valid("query").media_type;

        const where: SQL[] = [];

        where.push(eq(Post.library_id, c.req.valid("query").library_id));

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

        const authorAvatarFile = alias(DbFile, "author_avatar_file");

        let orderColumn: any;
        if (sortBy === "import_time") {
            orderColumn = Post.create_time;
        } else {
            orderColumn = sql`coalesce(${Post.published_time}, ${Post.create_time})`;
        }
        const orderByExpr = sortOrder === "asc" ? asc(orderColumn) : desc(orderColumn);

        const rawPosts = await db
            .select({
                id: Post.id,
                eid: Post.eid,
                title: Post.title,
                source: Post.source,
                tags: Post.tags,
                author_name: Post.author_name,
                create_time: Post.create_time,
                published_time: Post.published_time,
                url: Post.url,
                sync_status: Post.sync_status,
                last_error: Post.last_error,
                author_avatar_bucket: authorAvatarFile.bucket,
                author_avatar_path: authorAvatarFile.path,
            })
            .from(Post)
            .leftJoin(Author, eq(Post.author_id, Author.id))
            .leftJoin(authorAvatarFile, eq(Author.avatar_file_id, authorAvatarFile.id))
            .where(and(activePostFilter, ...where))
            .orderBy(orderByExpr)
            .limit(pageSize)
            .offset(offset);

        const postIds = rawPosts.map((p) => p.id);
        const mediaByPostId = new Map<string, any[]>();

        if (postIds.length > 0) {
            const mediaRows = await db
                .select({
                    id: Media.id,
                    eid: Media.eid,
                    post_id: Media.post_id,
                    source: Media.source,
                    title: Media.title,
                    description: Media.description,
                    type: Media.type,
                    sort_order: Media.sort_order,
                    create_time: Media.create_time,
                    published_time: Media.published_time,
                    sync_status: Media.sync_status,
                    last_error: Media.last_error,
                })
                .from(Media)
                .where(
                    and(
                        inArray(Media.post_id, postIds),
                        lte(Media.sort_order, 3), // up to 4 media items per post
                        activeMediaFilter,
                    ),
                )
                .orderBy(asc(Media.sort_order));

            const allMediaIds = mediaRows.map((mr) => mr.id);
            const filesByMediaId = new Map<string, any[]>();
            const aiMetadataMap = new Map<string, { ai_status: string; ai_error: string | null }>();

            if (allMediaIds.length > 0) {
                const aiMetadatas = await db
                    .select({
                        entity_id: AssetAiMetadata.entity_id,
                        processing_status: AssetAiMetadata.processing_status,
                        last_error: AssetAiMetadata.last_error,
                    })
                    .from(AssetAiMetadata)
                    .where(and(inArray(AssetAiMetadata.entity_id, allMediaIds), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)));

                for (const meta of aiMetadatas) {
                    const existing = aiMetadataMap.get(meta.entity_id);
                    if (
                        !existing ||
                        meta.processing_status === "COMPLETED" ||
                        (existing.ai_status !== "COMPLETED" && meta.processing_status === "FAILED")
                    ) {
                        aiMetadataMap.set(meta.entity_id, {
                            ai_status: meta.processing_status,
                            ai_error: meta.last_error,
                        });
                    }
                }

                const allFiles = await db
                    .select({
                        media_id: Track.media_id,
                        type: Track.type,
                        purpose: Track.purpose,
                        is_original: Track.is_original,
                        quality: Track.quality,
                        priority: Track.priority,
                        metadata: Track.metadata,
                        file_id: DbFile.id,
                        file_path: DbFile.path,
                        file_bucket: DbFile.bucket,
                        mime_type: DbFile.mime_type,
                        extension: DbFile.extension,
                        width: DbFile.width,
                        height: DbFile.height,
                    })
                    .from(Track)
                    .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
                    .where(
                        and(
                            inArray(Track.media_id, allMediaIds),
                            eq(Track.delete_status, DeleteStatus.ACTIVE),
                            eq(Track.sync_status, SyncStatus.COMPLETED),
                            inArray(Track.purpose, [TrackPurpose.CONTENT, TrackPurpose.COVER]),
                        ),
                    );

                for (const file of allFiles) {
                    if (!file.media_id) continue;
                    if (!filesByMediaId.has(file.media_id)) {
                        filesByMediaId.set(file.media_id, []);
                    }
                    filesByMediaId.get(file.media_id)!.push(file);
                }
            }

            for (const row of mediaRows) {
                if (!row.post_id) continue;
                if (!mediaByPostId.has(row.post_id)) {
                    mediaByPostId.set(row.post_id, []);
                }
                const files = filesByMediaId.get(row.id) || [];
                const aiMeta = aiMetadataMap.get(row.id);
                const response = mapMediaToResponse(
                    {
                        ...row,
                        ai_status: aiMeta?.ai_status,
                        ai_error: aiMeta?.ai_error,
                    },
                    files as any,
                );
                mediaByPostId.get(row.post_id)!.push(response);
            }
        }

        const posts = rawPosts.map((post) => {
            const postMedia = mediaByPostId.get(post.id) || [];
            let type: "MULTI_MEDIA" | "TEXT" = "TEXT";
            if (postMedia.length > 0) {
                type = "MULTI_MEDIA";
            }
            return {
                id: post.id,
                eid: post.eid,
                type: type,
                title: post.title,
                source: post.source,
                tags: post.tags,
                author_name: post.author_name,
                author_avatar_url: buildCdnUrl(post.author_avatar_bucket, post.author_avatar_path),
                create_time: toIsoTimestamp(post.create_time),
                published_time: toIsoTimestamp(post.published_time),
                url: post.url,
                sync_status: post.sync_status,
                last_error: post.last_error,
                media: postMedia,
            };
        });

        const total = await db
            .select({
                total: count(),
            })
            .from(Post)
            .where(and(activePostFilter, ...where));

        return c.json(
            success(Code.SUCCESS, {
                list: posts,
                total: total[0].total,
            }),
        );
    },
);

router.get(
    "/authors",
    requireAuth,
    validator("query", (value, c) => {
        const schema = z.object({
            library_id: z.uuid(),
            keyword: z.string().optional(),
            author_ids: z.string().optional(),
        });
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid request parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const { library_id, keyword, author_ids } = c.req.valid("query");

        const whereClause: SQL[] = [
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
    },
);

/** Post Detail Request Path Param Schema */
const PostDetailRequestPathParamSchema = z.object({
    id: z.uuid(),
});

export const PostDetailResponseBodySchema = z.object({
    id: z.uuid().optional(),
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

router.get(
    "/detail/:id",
    requireAuth,
    validator("param", (value, c) => {
        const parsed = PostDetailRequestPathParamSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid post ID"), 400);
        }
        return parsed.data.id;
    }),
    async (c) => {
        const id = c.req.valid("param");

        const authorAvatarFile = alias(DbFile, "author_avatar_file");

        const postRows = await db
            .select({
                id: Post.id,
                source: Post.source,
                eid: Post.eid,
                title: Post.title,
                description: Post.description,
                tags: Post.tags,
                author_name: Post.author_name,
                author_external_id: Post.author_external_id,
                create_time: Post.create_time,
                published_time: Post.published_time,
                media_count: Post.media_count,
                sync_status: Post.sync_status,
                last_error: Post.last_error,
                url: Post.url,
                author_avatar_bucket: authorAvatarFile.bucket,
                author_avatar_path: authorAvatarFile.path,
            })
            .from(Post)
            .leftJoin(Author, eq(Post.author_id, Author.id))
            .leftJoin(authorAvatarFile, eq(Author.avatar_file_id, authorAvatarFile.id))
            .where(and(eq(Post.id, id), activePostFilter))
            .limit(1);

        const postData = postRows[0];

        if (!postData) {
            return c.json(error(Code.NOT_FOUND, "Post not found"));
        }

        const mediaRows = await db
            .select({
                id: Media.id,
                eid: Media.eid,
                post_id: Media.post_id,
                source: Media.source,
                title: Media.title,
                description: Media.description,
                type: Media.type,
                sort_order: Media.sort_order,
                create_time: Media.create_time,
                published_time: Media.published_time,
                sync_status: Media.sync_status,
                last_error: Media.last_error,
            })
            .from(Media)
            .where(and(eq(Media.post_id, id), activeMediaFilter))
            .orderBy(asc(Media.sort_order));

        const allMediaIds = mediaRows.map((mr) => mr.id);
        const filesByMediaId = new Map<string, any[]>();
        const aiMetadataMap = new Map<string, { ai_status: string; ai_error: string | null }>();

        if (allMediaIds.length > 0) {
            const aiMetadatas = await db
                .select({
                    entity_id: AssetAiMetadata.entity_id,
                    processing_status: AssetAiMetadata.processing_status,
                    last_error: AssetAiMetadata.last_error,
                })
                .from(AssetAiMetadata)
                .where(and(inArray(AssetAiMetadata.entity_id, allMediaIds), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)));

            for (const meta of aiMetadatas) {
                const existing = aiMetadataMap.get(meta.entity_id);
                if (
                    !existing ||
                    meta.processing_status === "COMPLETED" ||
                    (existing.ai_status !== "COMPLETED" && meta.processing_status === "FAILED")
                ) {
                    aiMetadataMap.set(meta.entity_id, {
                        ai_status: meta.processing_status,
                        ai_error: meta.last_error,
                    });
                }
            }

            const allFiles = await db
                .select({
                    media_id: Track.media_id,
                    type: Track.type,
                    purpose: Track.purpose,
                    is_original: Track.is_original,
                    quality: Track.quality,
                    priority: Track.priority,
                    metadata: Track.metadata,
                    file_id: DbFile.id,
                    file_path: DbFile.path,
                    file_bucket: DbFile.bucket,
                    mime_type: DbFile.mime_type,
                    extension: DbFile.extension,
                    width: DbFile.width,
                    height: DbFile.height,
                })
                .from(Track)
                .leftJoin(DbFile, eq(Track.file_id, DbFile.id))
                .where(
                    and(
                        inArray(Track.media_id, allMediaIds),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                        eq(Track.sync_status, SyncStatus.COMPLETED),
                    ),
                );

            for (const file of allFiles) {
                if (!file.media_id) continue;
                if (!filesByMediaId.has(file.media_id)) {
                    filesByMediaId.set(file.media_id, []);
                }
                filesByMediaId.get(file.media_id)!.push(file);
            }
        }

        const mediaResponses = mediaRows.map((m) => {
            const files = filesByMediaId.get(m.id) || [];
            const aiMeta = aiMetadataMap.get(m.id);
            return {
                ...mapMediaToResponse(
                    {
                        ...m,
                        ai_status: aiMeta?.ai_status,
                        ai_error: aiMeta?.ai_error,
                    },
                    files,
                ),
                post_eid: postData.eid,
            };
        });

        const result: z.infer<typeof PostDetailResponseBodySchema> = {
            id: postData.id,
            source: postData.source,
            eid: postData.eid,
            title: postData.title,
            description: postData.description,
            tags: postData.tags,
            author_name: postData.author_name,
            author_avatar_url: buildCdnUrl(postData.author_avatar_bucket, postData.author_avatar_path),
            author_external_id: postData.author_external_id,
            create_time: toIsoTimestamp(postData.create_time) ?? undefined,
            published_time: toIsoTimestamp(postData.published_time),
            media_count: postData.media_count,
            type: mediaResponses.length > 0 ? "MULTI_MEDIA" : "TEXT",
            sync_status: postData.sync_status,
            last_error: postData.last_error,
            media: mediaResponses,
        };

        return c.json(success(Code.SUCCESS, result));
    },
);

router.post("/trash/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "post id is required"), 400);
    }

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

    const result = await DeleteService.deletePost(id);
    if (result.postUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Post not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

export default router;
