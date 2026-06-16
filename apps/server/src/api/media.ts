import { Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
import { validator } from "hono/validator";
import { success, error } from "@/lib/response";
import { Code } from "@/lib/code";
import {
    Media,
    Track,
    Post,
    File as DbFile,
    PostSource,
    DeleteStatus,
    TrackType,
    TrackPurpose,
    TrackQuality,
    AssetAiMetadata,
    EntityType,
    SyncStatus,
    type MediaFileMetadata,
} from "@/db/schema";
import { s3 } from "@/global/s3";
import { and, eq, ilike, SQL, count, desc, or, isNull, inArray } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { Temporal } from "@js-temporal/polyfill";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { Library } from "@/db/schema";
import { env } from "@/global/env";
import { VideoCoverService } from "@/services/video_cover";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

function escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, (c) => {
        switch (c) {
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case "&":
                return "&amp;";
            case "'":
                return "&apos;";
            case '"':
                return "&quot;";
            default:
                return c;
        }
    });
}

const router = new Hono<AuthEnv>();

export const MediaListRequestBodySchema = z.object({
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
    display_mode: z.enum(["flat", "stacked"]).default("flat"),
    library_id: z.uuid().optional(),
});

export interface MappedFileRow {
    media_id: string | null;
    type: TrackType;
    purpose: TrackPurpose;
    is_original: boolean;
    quality: TrackQuality;
    priority: number;
    metadata: MediaFileMetadata;
    file_id: string | null;
    file_path: string | null;
    file_bucket: string | null;
    mime_type: string | null;
    extension: string | null;
    width: number | null;
    height: number | null;
}

export function mapMediaToResponse(
    media: {
        id: string;
        eid: string;
        post_id: string | null;
        source: typeof Media.$inferSelect.source;
        title: string;
        description: string;
        type: typeof Media.$inferSelect.type;
        sort_order: number;
        create_time: Temporal.Instant;
        published_time: Temporal.Instant | null;
        sync_status: typeof Media.$inferSelect.sync_status;
        last_error: string | null;
        ai_status?: string | null;
        ai_error?: string | null;
    },
    files: MappedFileRow[],
) {
    const sortedFiles = [...files].sort((a, b) => a.priority - b.priority);

    const tracks = sortedFiles
        .filter((f) => f.file_path && f.file_bucket)
        .map((f) => ({
            id: f.file_id || "",
            url: buildCdnUrl(f.file_bucket!, f.file_path!) || "",
            type: f.type,
            purpose: f.purpose,
            is_original: f.is_original,
            quality: f.quality,
            priority: f.priority,
            metadata: f.metadata || {},
        }));

    const coverFile = sortedFiles.find((f) => f.purpose === TrackPurpose.COVER);
    const coverUrl =
        coverFile && coverFile.file_path && coverFile.file_bucket ? buildCdnUrl(coverFile.file_bucket, coverFile.file_path) : null;

    // Live Photo: IMAGE is primary
    const primaryFile = sortedFiles.find(
        (f) =>
            f.purpose === TrackPurpose.CONTENT &&
            f.priority === 0 &&
            (media.type === "VIDEO" ? f.type === TrackType.VIDEO : f.type === TrackType.IMAGE),
    );
    let primaryFileUrl =
        primaryFile && primaryFile.file_path && primaryFile.file_bucket
            ? buildCdnUrl(primaryFile.file_bucket, primaryFile.file_path)
            : null;

    const isFmp4 = primaryFile?.metadata?.type === "fmp4";
    if (media.type === "VIDEO" && isFmp4) {
        primaryFileUrl = `/api/media/${media.id}/manifest.mpd`;
    }

    return {
        id: media.id,
        eid: media.eid,
        post_id: media.post_id,
        source: media.source,
        title: media.title,
        description: media.description,
        type: media.type,
        sort_order: media.sort_order,
        create_time: toIsoTimestamp(media.create_time) ?? undefined,
        published_time: toIsoTimestamp(media.published_time) ?? undefined,
        sync_status: media.sync_status,
        last_error: media.last_error,
        ai_status: media.ai_status ?? "PENDING",
        ai_error: media.ai_error ?? null,
        url: primaryFileUrl,
        cover_url: coverUrl,
        width: primaryFile?.width ?? null,
        height: primaryFile?.height ?? null,
        tracks,
    };
}

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
            where.push(or(ilike(Media.title, `%${keyword}%`), ilike(Media.description, `%${keyword}%`))!);
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

        const rawMedia = await db
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
                post_media_count: Post.media_count,
                sync_status: Media.sync_status,
                last_error: Media.last_error,
            })
            .from(Media)
            .leftJoin(Post, eq(Media.post_id, Post.id))
            .where(visibleMediaFilter)
            .orderBy(desc(Media.create_time))
            .limit(pageSize)
            .offset(offset);

        const mediaIds = rawMedia.map((m) => m.id);
        const filesByMediaId = new Map<string, MappedFileRow[]>();
        const aiMetadataMap = new Map<string, { ai_status: string; ai_error: string | null }>();

        if (mediaIds.length > 0) {
            const aiMetadatas = await db
                .select({
                    entity_id: AssetAiMetadata.entity_id,
                    processing_status: AssetAiMetadata.processing_status,
                    last_error: AssetAiMetadata.last_error,
                })
                .from(AssetAiMetadata)
                .where(and(inArray(AssetAiMetadata.entity_id, mediaIds), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)));

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
                        inArray(Track.media_id, mediaIds),
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
                filesByMediaId.get(file.media_id)!.push(file as any);
            }
        }

        const medias = rawMedia.map((m) => {
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
                media_count: m.post_media_count || 1,
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

router.get("/detail/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const mediaResults = await db
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
            library_id: Media.library_id,
            sync_status: Media.sync_status,
            last_error: Media.last_error,
        })
        .from(Media)
        .where(and(eq(Media.id, id as string), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .limit(1);

    const media = mediaResults[0];
    if (!media) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    const libResults = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
    const library = libResults[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
    }

    const aiMetadatas = await db
        .select({
            processing_status: AssetAiMetadata.processing_status,
            last_error: AssetAiMetadata.last_error,
        })
        .from(AssetAiMetadata)
        .where(and(eq(AssetAiMetadata.entity_id, media.id), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)));

    let aiStatus = "PENDING";
    let aiError: string | null = null;
    for (const meta of aiMetadatas) {
        if (
            aiStatus !== "COMPLETED" &&
            (meta.processing_status === "COMPLETED" || (aiStatus !== "FAILED" && meta.processing_status === "FAILED"))
        ) {
            aiStatus = meta.processing_status;
            aiError = meta.last_error;
        }
    }

    const files = await db
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
            and(eq(Track.media_id, media.id), eq(Track.delete_status, DeleteStatus.ACTIVE), eq(Track.sync_status, SyncStatus.COMPLETED)),
        );

    const response = mapMediaToResponse(
        {
            ...media,
            ai_status: aiStatus,
            ai_error: aiError,
        },
        files as any,
    );
    return c.json(success(Code.SUCCESS, response));
});

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
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    const media = mediaResults[0];
    if (!media) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    if (media.type !== "VIDEO") {
        return c.json(error(Code.INVALID_PARAMETER, "Media is not a video"), 400);
    }

    // Verify user owns the library
    const libResults = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
    const library = libResults[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);

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
        return c.json(error(Code.INVALID_PARAMETER, "media_ids is required and cannot be empty"), 400);
    }

    if (mediaIds.length > 100) {
        return c.json(error(Code.INVALID_PARAMETER, "Cannot process more than 100 media items at once"), 400);
    }

    const mediaList = await db
        .select()
        .from(Media)
        .where(and(inArray(Media.id, mediaIds), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));

    if (mediaList.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No matching media items found"), 404);
    }

    // Verify user owns libraries of all found media
    const uniqueLibraryIds = Array.from(new Set(mediaList.map((m) => m.library_id))).filter((libId): libId is string => !!libId);
    const libraries = await db
        .select()
        .from(Library)
        .where(and(inArray(Library.id, uniqueLibraryIds), eq(Library.delete_status, DeleteStatus.ACTIVE)));

    const isAuthorized = libraries.every((lib) => lib.owner_id === user.id) && libraries.length === uniqueLibraryIds.length;
    if (!isAuthorized) {
        return c.json(error(Code.UNAUTHORIZED, "You do not have access to some of the selected libraries"), 403);
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);

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

const GetMpdRequestSchema = z.object({
    id: z.uuid(),
});
router.get(
    "/:id/manifest.mpd",
    requireAuth,
    validator("param", (value, c) => {
        const parsed = GetMpdRequestSchema.safeParse(value);
        if (!parsed.success) {
            return c.json(error(Code.INVALID_PARAMETER, "Invalid request parameter"), 400);
        }
        return parsed.data.id;
    }),
    async (c) => {
        const mediaId = c.req.valid("param");
        const user = c.get("user");
        if (!user) {
            return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
        }

        // 1. Fetch Media and verify active
        const mediaResults = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId as string), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .limit(1);
        const media = mediaResults[0];
        if (!media) {
            return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
        }

        // Verify user owns the library
        const libResults = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
        const library = libResults[0];
        if (!library || library.owner_id !== user.id) {
            return c.json(error(Code.UNAUTHORIZED, "You do not have access to this library"), 403);
        }

        // 2. Fetch associated video and audio tracks
        const tracks = await db
            .select()
            .from(Track)
            .where(
                and(
                    eq(Track.media_id, mediaId as string),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                    eq(Track.sync_status, SyncStatus.COMPLETED),
                ),
            );

        const videoFiles = tracks.filter((t) => t.type === TrackType.VIDEO && t.purpose === TrackPurpose.CONTENT);
        const audioFiles = tracks.filter((t) => t.type === TrackType.AUDIO && t.purpose === TrackPurpose.CONTENT);

        if (videoFiles.length === 0) {
            return c.json(error(Code.NOT_FOUND, "No video tracks found for this media"), 404);
        }

        // Fetch physical File records for pre-signed URLs
        const fileIds = tracks.map((t) => t.file_id).filter((fid): fid is string => !!fid);

        if (fileIds.length === 0) {
            return c.json(error(Code.NOT_FOUND, "No physical files found for this media"), 404);
        }

        const physicalFiles = await db
            .select()
            .from(DbFile)
            .where(and(inArray(DbFile.id, fileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));

        // Dynamic manifest generation
        const videoRepresentations: string[] = [];
        const audioRepresentations: string[] = [];

        const getPresignedUrlOrCdn = async (path: string, bucket: string) => {
            const cdnUrl = buildCdnUrl(bucket, path);
            if (cdnUrl) {
                return cdnUrl;
            }
            try {
                return await s3.getPresignedUrl(path, {
                    bucket,
                    expiresInSeconds: 3600 * 2, // 2 hours
                });
            } catch {
                return "";
            }
        };

        let mediaDuration = 0;

        for (const vf of videoFiles) {
            const file = physicalFiles.find((f) => f.id === vf.file_id);
            if (!file) continue;

            if (file.duration && file.duration > mediaDuration) {
                mediaDuration = file.duration;
            }

            const url = await getPresignedUrlOrCdn(file.path, file.bucket);
            const meta = vf.metadata;

            // DASH manifests require strict RFC 6381 codec parameters.
            // Generic names (e.g., "hevc", "av1", "h264") must be mapped to precise,
            // browser-compatible codec profile/level identifier strings.
            let codecs = meta?.codecs?.toLowerCase() || "avc1.640028";
            if (["hevc", "h265", "h.265"].includes(codecs)) {
                codecs = "hvc1.1.6.L150.90";
            } else if (["h264", "h.264", "avc"].includes(codecs)) {
                codecs = "avc1.640028";
            } else if (codecs === "av1") {
                codecs = "av01.0.08M.08";
            }

            const bandwidth = meta?.bandwidth || 1500000;
            const width = meta?.width || file.width || 1280;
            const height = meta?.height || file.height || 720;
            const indexRange = meta?.segment_base?.index_range || "915-5000";
            const initRange = meta?.segment_base?.initialization || "0-914";

            const timescale = meta?.segment_base?.timescale;
            const pto = meta?.segment_base?.earliest_presentation_time;
            const segmentBaseAttrs: string[] = [`indexRange="${indexRange}"`];
            if (timescale !== undefined) {
                segmentBaseAttrs.push(`timescale="${timescale}"`);
            }
            if (pto !== undefined) {
                segmentBaseAttrs.push(`presentationTimeOffset="${pto}"`);
            }

            videoRepresentations.push(`
      <Representation id="video_${vf.priority}" codecs="${codecs}" bandwidth="${bandwidth}" width="${width}" height="${height}">
        <BaseURL>${escapeXml(url)}</BaseURL>
        <SegmentBase ${segmentBaseAttrs.join(" ")}>
          <Initialization range="${initRange}" />
        </SegmentBase>
      </Representation>`);
        }

        for (const af of audioFiles) {
            const file = physicalFiles.find((f) => f.id === af.file_id);
            if (!file) continue;

            if (file.duration && file.duration > mediaDuration) {
                mediaDuration = file.duration;
            }

            const url = await getPresignedUrlOrCdn(file.path, file.bucket);
            const meta = af.metadata;
            let codecs = meta?.codecs || "mp4a.40.2";
            if (codecs === "aac") {
                codecs = "mp4a.40.2";
            }
            const bandwidth = meta?.bandwidth || 128000;
            const indexRange = meta?.segment_base?.index_range || "837-5000";
            const initRange = meta?.segment_base?.initialization || "0-836";

            const timescale = meta?.segment_base?.timescale;
            const pto = meta?.segment_base?.earliest_presentation_time;
            const segmentBaseAttrs: string[] = [`indexRange="${indexRange}"`];
            if (timescale !== undefined) {
                segmentBaseAttrs.push(`timescale="${timescale}"`);
            }
            if (pto !== undefined) {
                segmentBaseAttrs.push(`presentationTimeOffset="${pto}"`);
            }

            audioRepresentations.push(`
      <Representation id="audio_${af.priority}" codecs="${codecs}" bandwidth="${bandwidth}">
        <BaseURL>${escapeXml(url)}</BaseURL>
        <SegmentBase ${segmentBaseAttrs.join(" ")}>
          <Initialization range="${initRange}" />
        </SegmentBase>
      </Representation>`);
        }

        const durationStr = mediaDuration > 0 ? `PT${mediaDuration}S` : "PT0S";

        const mpd = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" type="static" mediaPresentationDuration="${durationStr}" minBufferTime="PT1.5S">
  <Period>
    <!-- Video Adaptation Set -->
    <AdaptationSet mimeType="video/mp4" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      ${videoRepresentations.join("\n")}
    </AdaptationSet>
    ${
        audioRepresentations.length > 0
            ? `
    <!-- Audio Adaptation Set -->
    <AdaptationSet mimeType="audio/mp4" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      ${audioRepresentations.join("\n")}
    </AdaptationSet>`
            : ""
    }
  </Period>
</MPD>`;

        c.header("Content-Type", "application/dash+xml");
        return c.text(mpd);
    },
);

export default router;
