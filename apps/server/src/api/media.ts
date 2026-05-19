import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { success } from "@/lib/response";
import { Code } from "@/lib/code";
import { Media, MediaFile, Post, File as DbFile } from "@/db/schema";
import { and, eq, ilike, SQL, count, desc, or, isNull, sql } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { Temporal } from "@js-temporal/polyfill";

const router = new Hono<AuthEnv>();

const toIsoTimestamp = (value: string | null | undefined) => {
    if (!value) return null;

    const normalized = value.includes("T") ? value : value.replace(" ", "T");
    const withTimeZone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
    return Temporal.Instant.from(withTimeZone).toString();
};

export const MediaListRequestBodySchema = z.object({
    page: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(1, "Page must be 1 or greater.").optional()
    ),
    count: z.preprocess(
        (val) => (val === "" || val === undefined ? undefined : Number(val)),
        z.number().int().positive().gte(10, "Count must be 10 or greater.").lte(100, "Count must be 100 or less.").optional()
    ),
    keyword: z.string().optional(),
    source: z.enum(["UNKNOWN", "X", "XHS", "BILIBILI", "DOUYIN", "TIKTOK", "INSTAGRAM"]).optional(),
    display_mode: z.enum(["flat", "stacked"]).default("flat"),
    library_id: z.string().uuid().optional(),
});

router.get(
    "/list",
    requireAuth,
    validator("query", (value, c) => {
        const parsed = MediaListRequestBodySchema.safeParse(value);
        if (!parsed.success) {
            return c.text("Invalid Request Parameter", 400);
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

        const { keyword, source, display_mode, library_id } = c.req.valid("query");

        const where: SQL[] = [];

        if (keyword) {
            where.push(ilike(Media.title, `%${keyword}%`));
        }
        if (source) {
            where.push(eq(Media.source, source));
        }
        if (library_id) {
            where.push(eq(Media.library_id, library_id));
        }

        // 双轨制：堆叠模式 vs 平铺模式
        // 平铺模式: 获取所有 Media
        // 堆叠模式: 仅获取独立的 Media (post_id is null) 或者 帖子中的首个 Media (sort_order = 0)
        if (display_mode === "stacked") {
            const stackedMediaFilter = or(isNull(Media.post_id), eq(Media.sort_order, 0));
            if (stackedMediaFilter) {
                where.push(stackedMediaFilter);
            }
        }

        const rawMedia = await db
            .select({
                id: Media.id,
                eid: Media.eid,
                post_id: Media.post_id,
                source: Media.source,
                title: Media.title,
                type: Media.type,
                create_time: Media.create_time,
                published_time: Media.published_time,
                s3_key: DbFile.s3_key,
                s3_bucket: DbFile.s3_bucket,
                post_media_count: Post.media_count,
            })
            .from(Media)
            .leftJoin(Post, eq(Media.post_id, Post.id))
            .leftJoin(MediaFile, and(eq(Media.id, MediaFile.media_id), eq(MediaFile.role, "PRIMARY")))
            .leftJoin(DbFile, eq(MediaFile.file_id, DbFile.id))
            .where(and(...where))
            .orderBy(desc(sql`coalesce(${Media.published_time}, ${Media.create_time})`))
            .limit(pageSize)
            .offset(offset);

        const medias = rawMedia.map((m) => {
            return {
                ...m,
                create_time: toIsoTimestamp(m.create_time),
                published_time: toIsoTimestamp(m.published_time),
                media_count: m.post_media_count || 1,
                // 抹平字段结构，方便前端直接使用 url
                media_url: m.s3_key ? `/${m.s3_bucket}/${m.s3_key}` : null, // Assuming local format, frontend handles CDN prefix usually, but let's just return s3_key and let frontend parse. Wait, post api returns raw fields.
            };
        });

        const totalResult = await db
            .select({ total: count() })
            .from(Media)
            .where(and(...where));

        return c.json(success(Code.SUCCESS, {
            list: medias,
            total: totalResult[0].total,
        }));
    }
);

export default router;
