import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { error, success } from "@/lib/response";
import { Code } from "@/lib/code";
import { requireAuth } from "@/lib/auth/middleware";
import {
    Media,
    MediaFile,
    Post,
    File as DbFile,
    DeleteStatus,
    PostSource,
    MediaFileRole,
} from "@/db/schema";
import { and, eq, ilike, SQL, count, asc, sql, isNull, inArray, lte } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Temporal } from "@js-temporal/polyfill";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

const router = new Hono();
const activePostFilter = and(
    eq(Post.delete_status, DeleteStatus.ACTIVE),
    isNull(Post.recycle_time),
);
const activeMediaFilter = and(
    eq(Media.delete_status, DeleteStatus.ACTIVE),
    isNull(Media.recycle_time),
);

/** Post List Request Body Schema */
export const PostListRequestBodySchema = z.object({
    library_id: z.uuid(),
    page: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1, "Page must be 1 or greater.").optional(),
    ),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z
            .number()
            .int()
            .positive()
            .gte(10, "Count must be 10 or greater.")
            .lte(100, "Count must be 100 or less.")
            .optional(),
    ),
    keyword: z.string().optional(),
    source: z.enum(PostSource).optional(),
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

        const where: SQL[] = [];

        where.push(eq(Post.library_id, c.req.valid("query").library_id));

        if (keyword) {
            where.push(ilike(Post.title, `%${keyword}%`));
        }
        if (source) {
            where.push(eq(Post.source, source));
        }

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
            })
            .from(Post)
            .where(and(activePostFilter, ...where))
            .orderBy(asc(sql`coalesce(${Post.published_time}, ${Post.create_time})`))
            .limit(pageSize)
            .offset(offset);

        interface PostListMediaItem {
            id: string;
            eid: string;
            source: typeof Media.$inferSelect.source;
            title: string;
            description: string;
            type: typeof Media.$inferSelect.type;
            sort_order: number;
            primary_file_url: string | null;
            cover_file_url: string | null;
            create_time: string | null;
            published_time: string | null;
        }

        const postIds = rawPosts.map((p) => p.id);
        const mediaByPostId = new Map<string, PostListMediaItem[]>();

        if (postIds.length > 0) {
            const primaryMediaFile = alias(MediaFile, "primary_media_file");
            const coverMediaFile = alias(MediaFile, "cover_media_file");
            const primaryDbFile = alias(DbFile, "primary_db_file");
            const coverDbFile = alias(DbFile, "cover_db_file");

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
                    primary_file_path: primaryDbFile.path,
                    primary_file_bucket: primaryDbFile.bucket,
                    cover_file_path: coverDbFile.path,
                    cover_file_bucket: coverDbFile.bucket,
                })
                .from(Media)
                .leftJoin(
                    primaryMediaFile,
                    and(
                        eq(Media.id, primaryMediaFile.media_id),
                        eq(primaryMediaFile.role, MediaFileRole.PRIMARY),
                    ),
                )
                .leftJoin(primaryDbFile, eq(primaryMediaFile.file_id, primaryDbFile.id))
                .leftJoin(
                    coverMediaFile,
                    and(
                        eq(Media.id, coverMediaFile.media_id),
                        eq(coverMediaFile.role, MediaFileRole.COVER),
                    ),
                )
                .leftJoin(coverDbFile, eq(coverMediaFile.file_id, coverDbFile.id))
                .where(
                    and(
                        inArray(Media.post_id, postIds),
                        lte(Media.sort_order, 3), // up to 4 media items per post
                        activeMediaFilter,
                    ),
                )
                .orderBy(asc(Media.sort_order));

            for (const row of mediaRows) {
                if (!row.post_id) continue;
                if (!mediaByPostId.has(row.post_id)) {
                    mediaByPostId.set(row.post_id, []);
                }
                mediaByPostId.get(row.post_id)!.push({
                    id: row.id,
                    eid: row.eid,
                    source: row.source,
                    title: row.title,
                    description: row.description,
                    type: row.type,
                    sort_order: row.sort_order,
                    primary_file_url: buildCdnUrl(row.primary_file_bucket, row.primary_file_path),
                    cover_file_url: buildCdnUrl(row.cover_file_bucket, row.cover_file_path),
                    create_time: toIsoTimestamp(row.create_time),
                    published_time: toIsoTimestamp(row.published_time),
                });
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
                create_time: toIsoTimestamp(post.create_time),
                published_time: toIsoTimestamp(post.published_time),
                url: post.url,
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
    author_external_id: z.string().nullable().optional(),
    create_time: z.string().optional(),
    published_time: z.string().nullable().optional(),
    media_count: z.number().optional(),
    type: z.enum(["TEXT", "MULTI_MEDIA"]).optional(),
    url: z.string().nullable().optional(),
    media: z
        .array(
            z.object({
                id: z.uuid(),
                eid: z.string().optional(),
                source: z.string().optional(),
                title: z.string().nullable().optional(),
                description: z.string().nullable().optional(),
                type: z.string().optional(),
                sort_order: z.number().optional(),
                primary_file_url: z.string().nullable().optional(),
                alternative_file_url: z.string().nullable().optional(),
                live_photo_video_url: z.string().nullable().optional(),
                cover_file_url: z.string().nullable().optional(),
                create_time: z.string().optional(),
                published_time: z.string().nullable().optional(),
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

        const postRows = await db
            .select()
            .from(Post)
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
                source: Media.source,
                title: Media.title,
                description: Media.description,
                type: Media.type,
                sort_order: Media.sort_order,
                create_time: Media.create_time,
                published_time: Media.published_time,
                file_role: MediaFile.role,
                file_path: DbFile.path,
                file_bucket: DbFile.bucket,
            })
            .from(Media)
            .leftJoin(MediaFile, eq(Media.id, MediaFile.media_id))
            .leftJoin(DbFile, eq(MediaFile.file_id, DbFile.id))
            .where(and(eq(Media.post_id, id), activeMediaFilter))
            .orderBy(asc(Media.sort_order), asc(MediaFile.sort_order));

        const mediaById = new Map<
            string,
            {
                id: string;
                eid: string;
                source: typeof Media.$inferSelect.source;
                title: string;
                description: string;
                type: typeof Media.$inferSelect.type;
                sort_order: number;
                create_time: Temporal.Instant;
                published_time: Temporal.Instant | null;
                files: Partial<
                    Record<
                        typeof MediaFile.$inferSelect.role,
                        { path: string | null; bucket: string | null }
                    >
                >;
            }
        >();

        for (const row of mediaRows) {
            const existing = mediaById.get(row.id);
            const media = existing ?? {
                id: row.id,
                eid: row.eid,
                source: row.source,
                title: row.title,
                description: row.description,
                type: row.type,
                sort_order: row.sort_order,
                create_time: row.create_time,
                published_time: row.published_time,
                files: {},
            };

            if (row.file_role) {
                media.files[row.file_role] = {
                    path: row.file_path ?? null,
                    bucket: row.file_bucket ?? null,
                };
            }

            if (!existing) {
                mediaById.set(row.id, media);
            }
        }

        const media = Array.from(mediaById.values());

        const result: z.infer<typeof PostDetailResponseBodySchema> = {
            id: postData.id,
            source: postData.source,
            eid: postData.eid,
            title: postData.title,
            description: postData.description,
            tags: postData.tags,
            author_name: postData.author_name,
            author_external_id: postData.author_external_id,
            create_time: toIsoTimestamp(postData.create_time) ?? undefined,
            published_time: toIsoTimestamp(postData.published_time),
            media_count: postData.media_count,
            type: media.length > 0 ? "MULTI_MEDIA" : "TEXT",
            url: postData.url,
            media: media.map((m) => {
                return {
                    id: m.id,
                    eid: m.eid,
                    post_eid: postData.eid,
                    source: m.source,
                    title: m.title,
                    description: m.description,
                    type: m.type,
                    sort_order: m.sort_order,
                    primary_file_url: buildCdnUrl(m.files.PRIMARY?.bucket, m.files.PRIMARY?.path),
                    alternative_file_url: buildCdnUrl(
                        m.files.ALTERNATIVE?.bucket,
                        m.files.ALTERNATIVE?.path,
                    ),
                    live_photo_video_url: buildCdnUrl(
                        m.files.LIVE_PHOTO_VIDEO?.bucket,
                        m.files.LIVE_PHOTO_VIDEO?.path,
                    ),
                    cover_file_url: buildCdnUrl(m.files.COVER?.bucket, m.files.COVER?.path),
                    create_time: toIsoTimestamp(m.create_time) ?? undefined,
                    published_time: toIsoTimestamp(m.published_time),
                };
            }),
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
