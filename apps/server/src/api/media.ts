import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import {
    Media,
    MediaFile,
    Post,
    File as DbFile,
    PostSource,
    DeleteStatus,
    MediaFileRole,
    AssetAiMetadata,
    EntityType,
} from "@/db/schema";
import { and, eq, ilike, SQL, count, desc, or, isNull, isNotNull, sql, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { Temporal } from "@js-temporal/polyfill";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { Library } from "@/db/schema";
import { env } from "@/global/env";
import { VideoCoverService } from "@/services/video_cover";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

const router = new Hono<AuthEnv>();

export const MediaListRequestBodySchema = z.object({
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
    display_mode: z.enum(["flat", "stacked"]).default("flat"),
    library_id: z.uuid().optional(),
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
            where.push(
                or(ilike(Media.title, `%${keyword}%`), ilike(Media.description, `%${keyword}%`))!,
            );
        }
        if (source) {
            where.push(eq(Media.source, source));
        }
        if (library_id) {
            where.push(eq(Media.library_id, library_id));
        }

        // Filter undeleted media
        where.push(eq(Media.delete_status, DeleteStatus.ACTIVE));
        where.push(isNull(Media.recycle_time));

        // 双轨制：堆叠模式 vs 平铺模式
        // 平铺模式: 获取所有 Media
        // 堆叠模式: 仅获取独立的 Media (post_id is null) 或者 帖子中的首个 Media (sort_order = 0)
        if (display_mode === "stacked") {
            const stackedMediaFilter = or(isNull(Media.post_id), eq(Media.sort_order, 0));
            if (stackedMediaFilter) {
                where.push(stackedMediaFilter);
            }
        }

        const visibleMediaFilter = and(...where);

        const primaryMediaFile = alias(MediaFile, "primary_media_file");
        const coverMediaFile = alias(MediaFile, "cover_media_file");
        const primaryDbFile = alias(DbFile, "primary_db_file");
        const coverDbFile = alias(DbFile, "cover_db_file");

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
                primary_file_path: primaryDbFile.path,
                primary_file_bucket: primaryDbFile.bucket,
                cover_file_path: coverDbFile.path,
                cover_file_bucket: coverDbFile.bucket,
                post_media_count: Post.media_count,
                sync_status: Media.sync_status,
                last_error: Media.last_error,
                ai_status: AssetAiMetadata.processing_status,
                ai_error: AssetAiMetadata.last_error,
            })
            .from(Media)
            .leftJoin(Post, eq(Media.post_id, Post.id))
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
            .leftJoin(
                AssetAiMetadata,
                and(
                    eq(Media.id, AssetAiMetadata.entity_id),
                    eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                ),
            )
            .where(visibleMediaFilter)
            .orderBy(desc(Media.create_time))
            .limit(pageSize)
            .offset(offset);

        const medias = rawMedia.map((m) => {
            return {
                id: m.id,
                eid: m.eid,
                post_id: m.post_id,
                source: m.source,
                title: m.title,
                type: m.type,
                create_time: toIsoTimestamp(m.create_time),
                published_time: toIsoTimestamp(m.published_time),
                media_count: m.post_media_count || 1,
                url: buildCdnUrl(m.primary_file_bucket, m.primary_file_path),
                cover: buildCdnUrl(m.cover_file_bucket, m.cover_file_path),
                sync_status: m.sync_status,
                last_error: m.last_error,
                ai_status: m.ai_status ?? "PENDING",
                ai_error: m.ai_error,
            };
        });

        const totalResult = await db
            .select({ total: count() })
            .from(Media)
            .leftJoin(Post, eq(Media.post_id, Post.id))
            .where(visibleMediaFilter);

        return c.json(
            success(Code.SUCCESS, {
                list: medias,
                total: totalResult[0].total,
            }),
        );
    },
);

router.post("/trash/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }

    const result = await RecycleService.recycleMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/restore/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }

    const result = await RecycleService.restoreMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/delete/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"));
    }

    const result = await DeleteService.deleteMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"));
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/:id/regenerate-cover", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }
    const mediaId = id as string;

    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    let body: { replace_external_cover?: boolean } = {};
    try {
        body = await c.req.json();
    } catch {
        // Safe fallback for empty body
    }

    const mediaResults = await db
        .select()
        .from(Media)
        .where(
            and(
                eq(Media.id, mediaId),
                eq(Media.delete_status, DeleteStatus.ACTIVE),
                isNull(Media.recycle_time),
            ),
        );
    const media = mediaResults[0];
    if (!media) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    if (media.type !== "VIDEO") {
        return c.json(error(Code.INVALID_PARAMETER, "Media is not a video"), 400);
    }

    // Verify user owns the library
    const libResults = await db
        .select()
        .from(Library)
        .where(eq(Library.id, media.library_id))
        .limit(1);
    const library = libResults[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto")
            ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}`
            : url.origin);

    const res = await VideoCoverService.requestForMedia(mediaId, {
        originUrl: origin,
        force: true,
        replaceExternalCover: body.replace_external_cover ?? false,
    });

    return c.json(success(Code.SUCCESS, res));
});

router.post("/regenerate-covers", requireAuth, async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    let body: { media_ids?: string[]; replace_external_cover?: boolean } = {};
    try {
        body = await c.req.json();
    } catch {
        return c.json(error(Code.INVALID_PARAMETER, "Invalid request body"), 400);
    }

    const mediaIds = Array.from(new Set(body.media_ids || []));
    if (mediaIds.length === 0) {
        return c.json(
            error(Code.INVALID_PARAMETER, "media_ids is required and cannot be empty"),
            400,
        );
    }

    if (mediaIds.length > 100) {
        return c.json(
            error(Code.INVALID_PARAMETER, "Cannot process more than 100 media items at once"),
            400,
        );
    }

    const mediaList = await db
        .select()
        .from(Media)
        .where(
            and(
                inArray(Media.id, mediaIds),
                eq(Media.delete_status, DeleteStatus.ACTIVE),
                isNull(Media.recycle_time),
            ),
        );

    if (mediaList.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No matching media items found"), 404);
    }

    // Verify user owns libraries of all found media
    const uniqueLibraryIds = Array.from(new Set(mediaList.map((m) => m.library_id))).filter(
        (libId): libId is string => !!libId,
    );
    const libraries = await db
        .select()
        .from(Library)
        .where(
            and(
                inArray(Library.id, uniqueLibraryIds),
                eq(Library.delete_status, DeleteStatus.ACTIVE),
            ),
        );

    const isAuthorized =
        libraries.every((lib) => lib.owner_id === user.id) &&
        libraries.length === uniqueLibraryIds.length;
    if (!isAuthorized) {
        return c.json(
            error(Code.UNAUTHORIZED, "You do not have access to some of the selected libraries"),
            403,
        );
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto")
            ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}`
            : url.origin);

    let queued = 0;
    let skipped = 0;
    let alreadyPending = 0;
    let failed = 0;

    const results: Array<{
        mediaId: string;
        status: "queued" | "skipped" | "already_pending" | "failed";
        reason?: string;
        error?: string;
    }> = [];

    for (const media of mediaList) {
        if (media.type !== "VIDEO") {
            skipped++;
            results.push({
                mediaId: media.id,
                status: "skipped",
                reason: "media_not_video",
            });
            continue;
        }

        try {
            const res = await VideoCoverService.requestForMedia(media.id, {
                originUrl: origin,
                force: true,
                replaceExternalCover: body.replace_external_cover ?? false,
            });

            if (res.status === "queued") {
                queued++;
            } else if (res.status === "skipped") {
                skipped++;
            } else if (res.status === "already_pending") {
                alreadyPending++;
            }

            results.push({
                mediaId: media.id,
                status: res.status,
                reason: res.status === "skipped" ? res.reason : undefined,
            });
        } catch (err: any) {
            failed++;
            results.push({
                mediaId: media.id,
                status: "failed",
                error: err.message || String(err),
            });
        }
    }

    return c.json(
        success(Code.SUCCESS, {
            requested: mediaIds.length,
            queued,
            skipped,
            alreadyPending,
            failed,
            results,
        }),
    );
});

export default router;
