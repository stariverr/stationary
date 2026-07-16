import { Context, Hono } from "hono";
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
    AssetAiMetadata,
    EntityType,
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
import { Codec, Quality } from "@/lib/types";
import { v7 as uuidv7 } from "uuid";
import { TrackService } from "@/services/track";
import { consumeDraftFile, DraftFileUnavailableError } from "@/services/draft-file";
import {
    assignTrackPriorities,
    validateDraftMediaGroups,
    validateDraftTrackFileTypes,
    MediaDraftSchema,
} from "@/lib/validation/media-composition";

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
    media_type: z.enum(MediaType).optional(),
    tag_ids: z.string().optional(),
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
        const tagIdsStr = c.req.valid("query").tag_ids;

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

        type Preview = {
            url: string | null;
            type: "VIDEO" | "IMAGE" | "AUDIO";
            quality: Quality;
            codec: string | null;
        };

        type MediaItem = Pick<typeof Media.$inferSelect, "id" | "post_id" | "type" | "sort_order"> & {
            covers: Preview[] | null;
            videos: Preview[] | null;
            audios: Preview[] | null;
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
                .where(
                    and(
                        inArray(Media.post_id, postIds),
                        lte(Media.sort_order, 3), // up to 4 media items per post
                        activeMediaFilter,
                    ),
                )
                .orderBy(asc(Media.sort_order));

            const allMediaIds = mediaRows.map((mr) => mr.id);
            type SelectedFile = Awaited<typeof fileQuery>[number];
            const filesByMediaId = new Map<string, SelectedFile[]>();

            const fileQuery = db
                .select({
                    media_id: Track.media_id,
                    purpose: Track.purpose,
                    is_original: Track.is_original,
                    priority: Track.priority,
                    quality: Track.quality,
                    type: Track.type,
                    codec: Track.codec,
                    file_path: DbFile.path,
                    file_bucket: DbFile.bucket,
                })
                .from(Track)
                .innerJoin(DbFile, eq(Track.file_id, DbFile.id));
            if (allMediaIds.length > 0) {
                const allFiles = await fileQuery.where(
                    and(
                        inArray(Track.media_id, allMediaIds),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                        eq(Track.sync_status, SyncStatus.COMPLETED),
                        inArray(Track.purpose, [TrackPurpose.CONTENT, TrackPurpose.COVER]),
                        inArray(Track.type, [TrackType.IMAGE, TrackType.VIDEO, TrackType.AUDIO]),
                    ),
                );
                for (const file of allFiles) {
                    let files = filesByMediaId.get(file.media_id);
                    if (!files) {
                        files = [];
                        filesByMediaId.set(file.media_id, files);
                    }
                    files.push(file);
                }
            }

            for (const row of mediaRows) {
                if (!row.post_id) continue;

                const files = filesByMediaId.get(row.id) || [];
                const sortedFiles = files.sort((a, b) => a.priority - b.priority);

                const covers: Preview[] = [];
                const coverFiles = sortedFiles.filter((f) => f.purpose === TrackPurpose.COVER);
                if (coverFiles.length) {
                    for (const coverFile of coverFiles) {
                        const coverUrl = coverFile ? buildCdnUrl(coverFile.file_bucket, coverFile.file_path) : null;
                        covers.push({
                            url: coverUrl,
                            type: "IMAGE",
                            quality: coverFile.quality,
                            codec: coverFile.codec,
                        });
                    }
                }
                // If no cover files, use original/cdn compressed version of image
                else if ([MediaType.IMAGE, MediaType.LIVE_PHOTO].includes(row.type)) {
                    const imageFiles = sortedFiles.filter((f) => f.purpose === TrackPurpose.CONTENT && f.type == TrackType.IMAGE);
                    if (imageFiles.length) {
                        for (const imageFile of imageFiles) {
                            // CF currently does not support processing these format, so do nothing
                            if (imageFile.codec && [Codec.HEIC, Codec.AVIF, Codec.JXL].includes(imageFile.codec as Codec)) {
                                const coverUrl = imageFile ? buildCdnUrl(imageFile.file_bucket, imageFile.file_path) : null;
                                covers.push({
                                    url: coverUrl,
                                    type: "IMAGE",
                                    quality: Quality.ORIGINAL,
                                    codec: imageFile.codec,
                                });
                            } else {
                                // Only compress other formats
                                for (const quality of [Quality.LOW, Quality.MEDIUM, Quality.HIGH]) {
                                    const coverUrl = imageFile
                                        ? buildImagePreviewCdnUrl(imageFile.file_bucket, imageFile.file_path, quality)
                                        : null;
                                    covers.push({
                                        url: coverUrl,
                                        type: "IMAGE",
                                        quality: quality,
                                        codec: imageFile.codec,
                                    });
                                }
                            }
                        }
                    }
                }

                let videos: Preview[] | null = null;
                if ([MediaType.LIVE_PHOTO, MediaType.VIDEO].includes(row.type)) {
                    const videoFiles = sortedFiles.filter((f) => f.purpose === TrackPurpose.CONTENT);
                    if (videoFiles.length) {
                        videos = [];
                        for (const videoFile of videoFiles) {
                            const videoUrl = videoFile ? buildCdnUrl(videoFile.file_bucket, videoFile.file_path) : null;
                            videos.push({
                                url: videoUrl,
                                type: "VIDEO",
                                quality: videoFile.quality,
                                codec: videoFile.codec,
                            });
                        }
                    }
                }

                let audios: Preview[] | null = null;
                if ([MediaType.AUDIO].includes(row.type)) {
                    // TODO
                }

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
                    covers,
                    videos,
                    audios,
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
            let type: "MULTI_MEDIA" | "TEXT" = "TEXT";
            if (postMedia.length > 0) {
                type = "MULTI_MEDIA";
            }
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
            platform: z.enum(PostSource).optional(),
        });
        const parsed = schema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid request parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
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
    },
);

/** Post Detail Request Path Param Schema */
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
                library_id: Post.library_id,
                source: Post.source,
                eid: Post.eid,
                title: Post.title,
                description: Post.description,
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

        const postTagsList = await db
            .select({ name: Tag.name })
            .from(PostTag)
            .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
            .where(and(eq(PostTag.post_id, id), eq(Tag.status, TagStatus.ACTIVE)))
            .orderBy(asc(PostTag.id));
        const postTags = postTagsList.map((pt) => pt.name);

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
                    track_id: Track.id,
                    media_id: Track.media_id,
                    type: Track.type,
                    purpose: Track.purpose,
                    is_original: Track.is_original,
                    quality: Track.quality,
                    priority: Track.priority,
                    metadata: Track.metadata,
                    variant_key: Track.variant_key,
                    is_default: Track.is_default,
                    display_name: Track.display_name,
                    language: Track.language,
                    codec: Track.codec,
                    is_stale: Track.is_stale,
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
            library_id: postData.library_id,
            source: postData.source,
            eid: postData.eid,
            title: postData.title,
            description: postData.description,
            tags: postTags,
            author_name: postData.author_name,
            author_avatar_url: buildImagePreviewCdnUrl(postData.author_avatar_bucket, postData.author_avatar_path, Quality.LOW),
            author_external_id: postData.author_external_id,
            create_time: toIsoTimestamp(postData.create_time) ?? undefined,
            published_time: toIsoTimestamp(postData.published_time),
            media_count: postData.media_count,
            type: mediaResponses.length > 0 ? "MULTI_MEDIA" : "TEXT",
            sync_status: postData.sync_status,
            last_error: postData.last_error,
            media: mediaResponses,
            url: postData.url,
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

async function checkPostAccess(
    c: Context,
    postId: string,
): Promise<{ post: typeof Post.$inferSelect; errorResponse: null } | { post: null; errorResponse: any }> {
    const user = c.get("user");
    if (!user) {
        return { post: null, errorResponse: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401) };
    }

    const postRows = await db.select().from(Post).where(eq(Post.id, postId)).limit(1);
    const post = postRows[0];

    if (!post || post.delete_status !== DeleteStatus.ACTIVE || post.recycle_time !== null) {
        return { post: null, errorResponse: c.json(error(Code.NOT_FOUND, "Post not found or is in recycle bin"), 404) };
    }

    const libraryList = await db.select().from(Library).where(eq(Library.id, post.library_id)).limit(1);
    const library = libraryList[0];

    if (!library || library.owner_id !== user.id) {
        return { post: null, errorResponse: c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403) };
    }

    const apiToken = c.get("apiToken");
    if (apiToken && apiToken.library_id && apiToken.library_id !== post.library_id) {
        return { post: null, errorResponse: c.json(error(Code.FORBIDDEN, "API token scope restricted to another library"), 403) };
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
    .refine(
        (data) => {
            return Object.keys(data).length > 0;
        },
        { message: "At least one field must be provided for update" },
    );

router.post(
    "/update-info/:id",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = PostUpdateInfoSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const id = c.req.param("id")!;
        const body = c.req.valid("json");

        const access = await checkPostAccess(c, id);
        if (access.errorResponse) return access.errorResponse;

        const updated = await PostService.updateInfo(id, body);
        return c.json(success(Code.SUCCESS, updated));
    },
);

const PostReplaceTagsSchema = z.object({
    tag_ids: z.array(z.uuid()),
});

router.post(
    "/:id/tags/replace",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = PostReplaceTagsSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid tag_ids array"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const id = c.req.param("id")!;
        const { tag_ids } = c.req.valid("json");

        const access = await checkPostAccess(c, id);
        if (!access.post || access.errorResponse) return access.errorResponse;
        const post = access.post;

        const resolvedTagIds = await PostService.replaceTags(id, post.library_id, tag_ids);
        return c.json(success(Code.SUCCESS, { tag_ids: resolvedTagIds }));
    },
);

const PostAttachMediaSchema = z.object({
    media_ids: z.array(z.uuid()).min(1, "media_ids must contain at least one ID"),
});

/** Bind media to post */
router.post(
    "/:id/bind_media",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = PostAttachMediaSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid media_ids"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
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
    },
);

const PostReorderMediaSchema = z.object({
    media_ids: z.array(z.uuid()).min(1, "media_ids must contain at least one ID"),
});

router.post(
    "/:id/media/reorder",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = PostReorderMediaSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid media_ids"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const id = c.req.param("id")!;
        const { media_ids } = c.req.valid("json");

        const access = await checkPostAccess(c, id);
        if (access.errorResponse) return access.errorResponse;

        const result = await PostService.reorderMedia(id, media_ids);

        if ("error" in result) {
            return c.json(error(Code.INVALID_PARAMETER, result.error || "Reorder failed"), 400);
        }

        return c.json(success(Code.SUCCESS, result));
    },
);

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

// 7. Create Post and optionally attach existing orphan media and consume draft files
router.post(
    "/create",
    requireAuth,
    validator("json", (value, c) => {
        const parsed = CreatePostSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, parsed.error.issues[0]?.message || "Invalid parameters"), 400);
        }
        return parsed.data;
    }),
    async (c) => {
        const body = c.req.valid("json");
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }

        // Verify library ownership
        const libraryList = await db.select().from(Library).where(eq(Library.id, body.library_id)).limit(1);
        const library = libraryList[0];
        if (!library || library.owner_id !== user.id) {
            return c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403);
        }

        // Derive media_ids and media_drafts from media_items if provided
        const mediaIds = body.media_items?.filter((item) => item.kind === "existing").map((item) => item.media_id) || [];
        const mediaDrafts = body.media_items?.filter((item) => item.kind === "draft").map((item) => item.draft) || [];

        if (mediaDrafts.length > 0) {
            const compositionError = validateDraftMediaGroups(mediaDrafts);
            if (compositionError) {
                return c.json(error(Code.INVALID_PARAMETER, compositionError), 400);
            }
        }

        // Verify whether media items are isolated
        if (mediaIds.length > 0) {
            const mediaList = await db
                .select()
                .from(Media)
                .where(and(inArray(Media.id, mediaIds), eq(Media.library_id, body.library_id)));
            if (mediaList.length !== mediaIds.length) {
                return c.json(error(Code.INVALID_PARAMETER, "Some media items are invalid or do not belong to this library"), 400);
            }
            // Ensure they are orphans
            for (const media of mediaList) {
                if (media.post_id !== null) {
                    return c.json(error(Code.INVALID_PARAMETER, `Media ${media.title} is already linked to a post`), 400);
                }
            }
        }

        // Verify draft files belong to this library and are in DRAFT status
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

                // Create Post
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

                // Check if all media items under the post are COMPLETED
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
    },
);

export default router;
