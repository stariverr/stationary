import { Context, Hono } from "hono";
import { db } from "@/global/db";
import { z } from "zod";
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
    AssetAiMetadata,
    EntityType,
    SyncStatus,
    Library,
    Tag,
    MediaTag,
    TagStatus,
    DraftFile,
    DraftFileStatus,
    MediaType,
    AsyncTaskType,
    TrackStreamLayout,
} from "@/db/schema";
import { s3 } from "@/global/s3";
import { and, eq, ilike, SQL, count, asc, desc, or, isNull, inArray } from "drizzle-orm";

import { Quality } from "@/lib/types";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { verifyMediaSignature } from "@/lib/utils/media-signer";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { MediaService } from "@/services/media";
import { TrackService } from "@/services/track";
import { v7 as uuidv7 } from "uuid";
import { env } from "@/global/env";
import { JobManager } from "@/infra/jobs/manager";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { consumeDraftFile, DraftFileUnavailableError } from "@/services/draft-file";
import { FormTimestampSchema, toIsoTimestamp } from "@/lib/utils/time";
import {
    assignTrackPriorities,
    validateNoDuplicateDraftFileIds,
    validateDraftTrackFileTypes,
    validateMediaComposition,
} from "@/lib/validation/media-composition";
import { getAllowedTrackTypesForFile, getFileExtension, getMimeTypeByExt } from "@/lib/utils/file";
import { validate } from "@/lib/validation/validator";

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
    has_no_post: z.string().optional(),
});

// Media List - Cover-only media hydration (zero content track queries)
router.get("/list", requireAuth, validate("query", MediaListRequestBodySchema), async (c) => {
    const query = c.req.valid("query");
    const page = query.page ?? 1;
    let pageSize = query.count ?? 20;
    if (pageSize > 100) {
        pageSize = 100;
    }
    const offset = (page - 1) * pageSize;
    const { keyword, source, display_mode, library_id, has_no_post } = query;

    const where: SQL[] = [];

    if (has_no_post === "true") {
        where.push(isNull(Media.post_id));
    }
    if (keyword) {
        where.push(or(ilike(Media.title, `%${keyword}%`), ilike(Media.description, `%${keyword}%`))!);
    }
    if (source) {
        where.push(eq(Media.source, source));
    }
    if (library_id) {
        where.push(eq(Media.library_id, library_id));
    }

    where.push(eq(Media.delete_status, DeleteStatus.ACTIVE));
    where.push(isNull(Media.recycle_time));

    if (display_mode === "stacked") {
        const stackedMediaFilter = or(isNull(Media.post_id), eq(Media.sort_order, 0));
        if (stackedMediaFilter) {
            where.push(stackedMediaFilter!);
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
    const coversByMediaId = await MediaService.getCoversMap(mediaIds);

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
    }

    const medias = rawMedia.map((m) => {
        const covers = coversByMediaId.get(m.id) || [];
        const aiMeta = aiMetadataMap.get(m.id);

        return {
            id: m.id,
            eid: m.eid,
            post_id: m.post_id,
            source: m.source,
            title: m.title,
            description: m.description,
            type: m.type,
            sort_order: m.sort_order,
            create_time: toIsoTimestamp(m.create_time) ?? undefined,
            published_time: toIsoTimestamp(m.published_time) ?? undefined,
            sync_status: m.sync_status,
            last_error: m.last_error,
            ai_status: aiMeta?.ai_status ?? "PENDING",
            ai_error: aiMeta?.ai_error ?? null,
            url: null,
            width: null,
            height: null,
            tracks: [],
            media_count: m.post_media_count || 1,
            covers: covers,
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
            total: totalResult[0]?.total ?? 0,
        }),
    );
});

router.get("/detail/:id", requireAuth, async (c) => {
    const id = c.req.param("id")!;
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

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

    const mediaTagsList = await db
        .select({ name: Tag.name })
        .from(MediaTag)
        .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
        .where(and(eq(MediaTag.media_id, media.id), eq(Tag.status, TagStatus.ACTIVE)))
        .orderBy(asc(MediaTag.id));
    const mediaTags = mediaTagsList.map((mt) => mt.name);

    const mediaDetail = await MediaService.getDetail(media);

    const response = {
        ...mediaDetail,
        ai_status: aiStatus,
        ai_error: aiError,
        tags: mediaTags,
    };
    return c.json(success(Code.SUCCESS, response));
});

router.post("/trash/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

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

    const access = await checkMediaOwnership(c, id, true);
    if (access.errorResponse) return access.errorResponse;

    const result = await RecycleService.restoreMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});

router.post("/delete/:id", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }

    const access = await checkMediaOwnership(c, id, true);
    if (access.errorResponse) return access.errorResponse;

    const result = await DeleteService.deleteMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});
export const SingleRegenerateCoverParamSchema = z.object({
    id: z.uuid("Invalid media ID format"),
});

router.post("/:id/regenerate-cover", requireAuth, validate("param", SingleRegenerateCoverParamSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }
    const { id } = c.req.valid("param");

    const access = await checkMediaAccess(c, id);
    if (!access.media || access.errorResponse) return access.errorResponse;
    const media = access.media;

    if (!media.library_id) {
        return c.json(error(Code.INVALID_PARAMETER, "Media has no associated library"), 400);
    }

    if (media.type !== MediaType.IMAGE && media.type !== MediaType.LIVE_PHOTO && media.type !== MediaType.VIDEO) {
        return c.json(error(Code.INVALID_PARAMETER, "Media type does not support cover photo generation"), 400);
    }

    const libList = await db
        .select()
        .from(Library)
        .where(and(eq(Library.id, media.library_id), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    const library = libList[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.UNAUTHORIZED, "Library not found or access denied"), 403);
    }

    const qualities = (library.cover_qualities as Quality[]) || [Quality.LOW, Quality.MEDIUM];
    const configVersion = library.cover_config_version || 1;

    const job = await JobManager.createTask({
        type: AsyncTaskType.COVER_BATCH,
        libraryId: media.library_id,
        ownerId: user.id,
        inputSnapshot: {
            source_type: "MANUAL",
            media_ids: [media.id],
            qualities,
        },
        configVersion,
    });

    return c.json(
        success(Code.SUCCESS, {
            mediaId: media.id,
            jobId: job.id,
            status: job.status,
        }),
    );
});

export const BatchRegenerateCoversSchema = z
    .object({
        library_id: z.uuid("Invalid library_id format"),
        media_ids: z.array(z.uuid("Invalid media_id format")).optional(),
        post_ids: z.array(z.uuid("Invalid post_id format")).optional(),
        replace_external_cover: z.boolean().optional(),
    })
    .refine((data) => (data.media_ids?.length || 0) + (data.post_ids?.length || 0) > 0, {
        message: "Either media_ids or post_ids must be provided and cannot be empty",
        path: ["media_ids"],
    });

router.post("/regenerate-covers", requireAuth, validate("json", BatchRegenerateCoversSchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const { library_id, media_ids, post_ids } = c.req.valid("json");
    const uniqueMediaIds = Array.from(new Set(media_ids || []));
    const uniquePostIds = Array.from(new Set(post_ids || []));

    if (uniqueMediaIds.length + uniquePostIds.length > 100) {
        return c.json(error(Code.INVALID_PARAMETER, "Cannot process more than 100 media or post items at once"), 400);
    }

    // Validate target library
    const libList = await db
        .select()
        .from(Library)
        .where(and(eq(Library.id, library_id), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);
    const library = libList[0];
    if (!library || library.owner_id !== user.id) {
        return c.json(error(Code.UNAUTHORIZED, "Library not found or access denied"), 403);
    }

    const filters: SQL[] = [];
    if (uniqueMediaIds.length > 0) {
        filters.push(inArray(Media.id, uniqueMediaIds));
    }
    if (uniquePostIds.length > 0) {
        filters.push(inArray(Media.post_id, uniquePostIds));
    }

    const mediaList = await db
        .select()
        .from(Media)
        .where(
            and(eq(Media.library_id, library_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time), or(...filters)),
        );

    if (mediaList.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No matching media items found in the specified library"), 404);
    }

    // Judge whether all media are found by id
    if (uniqueMediaIds.length > 0) {
        const foundMediaIds = new Set(mediaList.map((m) => m.id));
        const missingExplicitMedia = uniqueMediaIds.some((id) => !foundMediaIds.has(id));
        if (missingExplicitMedia) {
            return c.json(error(Code.INVALID_PARAMETER, "All specified media items must belong to the specified library"), 400);
        }
    }

    const qualities = library.cover_qualities || [Quality.LOW, Quality.MEDIUM];
    const configVersion = library.cover_config_version || 1;

    const job = await JobManager.createTask({
        type: AsyncTaskType.COVER_BATCH,
        libraryId: library_id,
        ownerId: user.id,
        inputSnapshot: {
            source_type: "MANUAL",
            media_ids: mediaList.map((m) => m.id),
            qualities,
        },
        configVersion,
    });

    return c.json(
        success(Code.SUCCESS, {
            queued_media_count: mediaList.length,
            job_id: job.id,
            status: job.status,
        }),
    );
});

const GetMpdRequestSchema = z.object({
    id: z.uuid(),
});

router.get("/:id/manifest.mpd", validate("param", GetMpdRequestSchema), async (c) => {
    const mediaId = c.req.valid("param").id;
    const access = await verifyMediaStreamAccess(c, mediaId);
    if (!access.ok) return access.errorResponse;

    const mpd = await MediaService.getDashManifest(mediaId);
    if (!mpd) {
        return c.json(error(Code.NOT_FOUND, "No playable DASH video tracks found for this media"), 404);
    }

    c.header("Content-Type", "application/dash+xml");
    return c.text(mpd);
});

const GetHlsRequestSchema = z.object({
    id: z.uuid(),
});

const GetHlsVariantRequestSchema = z.object({
    id: z.uuid(),
    trackId: z.uuid(),
});

router.get("/:id/manifest.m3u8", validate("param", GetHlsRequestSchema), async (c) => {
    const mediaId = c.req.valid("param").id;
    const access = await verifyMediaStreamAccess(c, mediaId);
    if (!access.ok) return access.errorResponse;

    const videoTrackId = c.req.query("video_track_id");
    const audioTrackId = c.req.query("audio_track_id");

    const rawQuery = c.req.query();
    const queryParams = new URLSearchParams(rawQuery);
    const queryString = queryParams.toString();
    const querySuffix = queryString ? `?${queryString}` : undefined;

    const m3u8 = await MediaService.getHlsMasterManifest(mediaId, querySuffix, {
        videoTrackId,
        audioTrackId,
    });
    if (!m3u8) {
        return c.json(error(Code.NOT_FOUND, "No playable HLS video tracks found for this media"), 404);
    }

    return c.newResponse(m3u8, 200, {
        "Content-Type": "application/x-mpegURL",
    });
});

router.get("/:id/hls/:trackId/manifest.m3u8", validate("param", GetHlsVariantRequestSchema), async (c) => {
    const { id: mediaId, trackId } = c.req.valid("param");
    const access = await verifyMediaStreamAccess(c, mediaId, trackId);
    if (!access.ok) return access.errorResponse;

    const rawQuery = c.req.query();
    const queryParams = new URLSearchParams(rawQuery);
    const queryString = queryParams.toString();
    const querySuffix = queryString ? `?${queryString}` : undefined;

    const m3u8 = await MediaService.getHlsVariantManifest(mediaId, trackId, querySuffix);
    if (!m3u8) {
        return c.json(error(Code.NOT_FOUND, "No playable HLS variant track found"), 404);
    }

    return c.newResponse(m3u8, 200, {
        "Content-Type": "application/x-mpegURL",
    });
});

async function verifyMediaStreamAccess(
    c: Context,
    mediaId: string,
    trackId?: string,
): Promise<{ ok: boolean; errorResponse: any }> {
    const expires = c.req.query("expires");
    const sig = c.req.query("sig");

    // 1. Zero-DB HMAC Signature Check (Industry Standard Signed URL)
    if (expires && sig) {
        const isValid = verifyMediaSignature(mediaId, trackId, expires, sig);
        if (isValid) {
            return { ok: true, errorResponse: null };
        }
        return {
            ok: false,
            errorResponse: c.json(error(Code.FORBIDDEN, "Invalid or expired media signature"), 403),
        };
    }

    // 2. Session / API Token check fallback if no signature provided
    const access = await checkMediaAccess(c, mediaId);
    if (!access.media || access.errorResponse) {
        return { ok: false, errorResponse: access.errorResponse };
    }

    return { ok: true, errorResponse: null };
}

async function checkMediaAccess(
    c: Context,
    mediaId: string,
): Promise<{ media: typeof Media.$inferSelect; errorResponse: null } | { media: null; errorResponse: any }> {
    return checkMediaOwnership(c, mediaId, false);
}

async function checkMediaOwnership(
    c: Context,
    mediaId: string,
    allowRecycled: boolean,
): Promise<{ media: typeof Media.$inferSelect; errorResponse: null } | { media: null; errorResponse: any }> {
    const user = c.get("user");
    if (!user) {
        return {
            media: null,
            errorResponse: c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401),
        };
    }

    const mediaRows = await db.select().from(Media).where(eq(Media.id, mediaId)).limit(1);
    const media = mediaRows[0];

    if (!media || media.delete_status !== DeleteStatus.ACTIVE || (!allowRecycled && media.recycle_time !== null)) {
        return {
            media: null,
            errorResponse: c.json(error(Code.NOT_FOUND, "Media not found or is in recycle bin"), 404),
        };
    }

    const libraryList = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
    const library = libraryList[0];

    if (!library || library.owner_id !== user.id) {
        return {
            media: null,
            errorResponse: c.json(error(Code.FORBIDDEN, "You do not have access to this library"), 403),
        };
    }

    const apiToken = c.get("apiToken");
    if (apiToken && apiToken.library_id && apiToken.library_id !== media.library_id) {
        return {
            media: null,
            errorResponse: c.json(error(Code.FORBIDDEN, "API token scope restricted to another library"), 403),
        };
    }

    return { media, errorResponse: null };
}

const MediaUpdateInfoSchema = z
    .object({
        title: z.string().min(1, "Title cannot be empty").optional(),
        description: z.string().optional(),
        published_time: FormTimestampSchema,
    })
    .refine((data) => Object.keys(data).length > 0, {
        message: "At least one field must be provided for update",
    });

router.post("/update-info/:id", requireAuth, validate("json", MediaUpdateInfoSchema), async (c) => {
    const id = c.req.param("id")!;
    const body = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const updated = await MediaService.updateInfo(id, body);
    return c.json(success(Code.SUCCESS, updated));
});

const MediaReplaceTagsSchema = z.object({
    tags: z.array(z.string()),
});

router.post("/:id/tags/replace", requireAuth, validate("json", MediaReplaceTagsSchema), async (c) => {
    const id = c.req.param("id")!;
    const { tags } = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const resolvedTagIds = await MediaService.replaceTags(id, media.library_id, tags);
    return c.json(success(Code.SUCCESS, { tag_ids: resolvedTagIds }));
});

router.get("/:id/tracks", requireAuth, async (c) => {
    const id = c.req.param("id")!;
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const tracks = await TrackService.listTracks(id);

    const result = tracks.map((t) => ({
        ...t.track,
        file: t.file
            ? {
                  ...t.file,
                  url: buildCdnUrl(t.file.bucket, t.file.path),
              }
            : null,
    }));

    return c.json(success(Code.SUCCESS, result));
});

const PresignUploadSchema = z.object({
    type: z.enum(TrackType),
    purpose: z.enum(TrackPurpose),
    quality: z.enum(Quality),
    priority: z.number().int().default(0),
    fileName: z.string().min(1, "fileName is required"),
});

router.post("/:id/tracks/presign-upload", requireAuth, validate("json", PresignUploadSchema), async (c) => {
    const id = c.req.param("id")!;
    const { type, purpose, priority, fileName } = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const allowedTrackTypes = getAllowedTrackTypesForFile(fileName);
    if (!allowedTrackTypes.includes(type)) {
        const expected = allowedTrackTypes.length > 0 ? allowedTrackTypes.join(" or ") : "a supported media";
        return c.json(error(Code.INVALID_PARAMETER, `${fileName} must be uploaded as ${expected} track`), 400);
    }

    const ext = getFileExtension(fileName) || "bin";
    const fileId = uuidv7();
    const prefix = `${type.toLowerCase()}_${purpose.toLowerCase()}_${priority}`;
    const postId = media.post_id;
    const libraryId = media.library_id;

    const path = postId
        ? `v2/p/${postId.slice(-2)}/${postId}/${media.id}_${prefix}_${fileId}.${ext}`
        : `v2/l/${libraryId.slice(-2)}/${libraryId}/${media.id}_${prefix}_${fileId}.${ext}`;

    const mimeType = getMimeTypeByExt(ext);
    const uploadUrl = await s3.getUploadPresignedUrl(path, {
        bucket: env.S3_BUCKET,
        contentType: mimeType,
        expiresInSeconds: 3600,
    });

    return c.json(
        success(Code.SUCCESS, {
            url: uploadUrl,
            path: path,
            bucket: env.S3_BUCKET,
            mime_type: mimeType,
            extension: ext,
        }),
    );
});

const RegisterTrackSchema = z.object({
    type: z.enum(TrackType),
    purpose: z.enum(TrackPurpose),
    quality: z.enum(Quality),
    priority: z.number().int().default(0),
    source_url: z.string().optional(),
    metadata: z.any().optional(),
    variant_key: z.string().optional(),
    is_default: z.boolean().optional(),
    is_primary: z.boolean().optional(),
    display_name: z.string().optional(),
    language: z.string().nullable().optional(),
    codec: z.string().nullable().optional(),
    duration: z.number().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    bandwidth: z.number().nonnegative().nullable().optional(),
    is_stale: z.boolean().optional(),
    source_track_id: z.string().nullable().optional(),
    container: z.string().nullable().optional(),
    is_fragmented: z.boolean().nullable().optional(),
    stream_layout: z.enum(TrackStreamLayout).nullable().optional(),
    has_video: z.boolean().nullable().optional(),
    has_audio: z.boolean().nullable().optional(),
    streams: z
        .array(
            z.object({
                index: z.number().int().nonnegative(),
                id: z.string().nullable().optional(),
                type: z.enum([TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE]),
                codec: z.string().nullable().optional(),
                language: z.string().nullable().optional(),
                label: z.string().nullable().optional(),
                role: z.string().nullable().optional(),
                width: z.number().int().positive().nullable().optional(),
                height: z.number().int().positive().nullable().optional(),
                bandwidth: z.number().nonnegative().nullable().optional(),
                channels: z.number().int().positive().nullable().optional(),
                sample_rate: z.number().int().positive().nullable().optional(),
                is_default: z.boolean().optional(),
            }),
        )
        .nullable()
        .optional(),
    file: z.object({
        path: z.string().min(1),
        bucket: z.string().min(1),
        mime_type: z.string().min(1),
        extension: z.string().min(1),
        size: z.number().int().nonnegative(),
    }),
});

router.post("/:id/tracks/upsert", requireAuth, validate("json", RegisterTrackSchema), async (c) => {
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const result = await db.transaction(async (tx) => {
        return TrackService.upsertTrack(
            id,
            {
                type: body.type,
                purpose: body.purpose,
                quality: body.quality,
                priority: body.priority,
                source_url: body.source_url,
                metadata: body.metadata,
                variant_key: body.variant_key,
                is_default: body.is_default,
                is_primary: body.is_primary,
                display_name: body.display_name,
                language: body.language,
                codec: body.codec,
                is_stale: body.is_stale,
                source_track_id: body.source_track_id,
                container: body.container,
                is_fragmented: body.is_fragmented,
                stream_layout: body.stream_layout,
                has_video: body.has_video,
                has_audio: body.has_audio,
                streams: body.streams,
            },
            body.file,
            tx,
        );
    });

    return c.json(success(Code.SUCCESS, result));
});

const ReplaceFileSchema = z.object({
    file: z.object({
        path: z.string().min(1),
        bucket: z.string().min(1),
        mime_type: z.string().min(1),
        extension: z.string().min(1),
        size: z.number().int().nonnegative(),
        width: z.number().int().positive().nullable().optional(),
        height: z.number().int().positive().nullable().optional(),
        duration: z.number().nullable().optional(),
    }),
});

router.post("/:id/tracks/:trackId/replace-file", requireAuth, validate("json", ReplaceFileSchema), async (c) => {
    const id = c.req.param("id")!;
    const trackId = c.req.param("trackId")!;
    const { file } = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        const result = await TrackService.replaceFile(id, trackId, file);
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        return c.json(error(Code.INVALID_PARAMETER, e.message || "File replacement failed"), 400);
    }
});

router.post("/:id/tracks/:trackId/delete", requireAuth, async (c) => {
    const id = c.req.param("id");
    const trackId = c.req.param("trackId");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }
    if (!trackId) {
        return c.json(error(Code.INVALID_PARAMETER, "track id is required"), 400);
    }

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        const result = await TrackService.deleteTrack(id, trackId);
        return c.json(success(Code.SUCCESS, result));
    } catch (e: any) {
        return c.json(error(Code.INVALID_PARAMETER, e.message || "Delete failed"), 400);
    }
});

const UpdateTrackMetadataSchema = z.object({
    priority: z.number().int().optional(),
    quality: z.enum(Quality).optional(),
    display_name: z.string().nullable().optional(),
    variant_key: z.string().optional(),
    is_default: z.boolean().optional(),
    is_primary: z.boolean().optional(),
    language: z.string().nullable().optional(),
    codec: z.string().nullable().optional(),
    is_stale: z.boolean().optional(),
    metadata: z.any().optional(),
    source_track_id: z.string().nullable().optional(),
    container: z.string().nullable().optional(),
    is_fragmented: z.boolean().nullable().optional(),
    stream_layout: z.enum(TrackStreamLayout).nullable().optional(),
    has_video: z.boolean().nullable().optional(),
    has_audio: z.boolean().nullable().optional(),
    streams: z
        .array(
            z.object({
                index: z.number().int().nonnegative(),
                id: z.string().nullable().optional(),
                type: z.enum([TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE]),
                codec: z.string().nullable().optional(),
                language: z.string().nullable().optional(),
                label: z.string().nullable().optional(),
                role: z.string().nullable().optional(),
                width: z.number().int().positive().nullable().optional(),
                height: z.number().int().positive().nullable().optional(),
                bandwidth: z.number().nonnegative().nullable().optional(),
                channels: z.number().int().positive().nullable().optional(),
                sample_rate: z.number().int().positive().nullable().optional(),
                is_default: z.boolean().optional(),
            }),
        )
        .nullable()
        .optional(),
});

router.post("/:id/tracks/:trackId/update", requireAuth, validate("json", UpdateTrackMetadataSchema), async (c) => {
    const id = c.req.param("id");
    const trackId = c.req.param("trackId");
    const body = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const updated = await TrackService.updateTrackMetadata(id, trackId, body);
    return c.json(success(Code.SUCCESS, updated));
});

const AddTracksFromDraftSchema = z.object({
    tracks: z
        .array(
            z.object({
                draft_file_id: z.uuid(),
                type: z.enum(TrackType),
                purpose: z.enum(TrackPurpose),
                quality: z.enum(Quality),
                is_default: z.boolean().default(false),
                language: z.string().nullable().optional(),
            }),
        )
        .min(1),
});

router.post("/:id/tracks/from-draft", requireAuth, validate("json", AddTracksFromDraftSchema), async (c) => {
    const id = c.req.param("id")!;
    const { tracks } = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (!access.media || access.errorResponse) return access.errorResponse;
    const media = access.media;

    const draftIdError = validateNoDuplicateDraftFileIds(tracks);
    if (draftIdError) {
        return c.json(error(Code.INVALID_PARAMETER, draftIdError), 400);
    }

    const incomingDefaultGroups = new Set(tracks.filter((track) => track.is_default).map((track) => `${track.type}:${track.purpose}`));
    const existingTracks = await db
        .select({
            type: Track.type,
            purpose: Track.purpose,
            is_default: Track.is_default,
            priority: Track.priority,
        })
        .from(Track)
        .where(and(eq(Track.media_id, id), eq(Track.delete_status, DeleteStatus.ACTIVE)));

    const prioritizedTracks = assignTrackPriorities(tracks, existingTracks);
    const effectiveTracks = [
        ...existingTracks.map((track) => ({
            ...track,
            is_default: incomingDefaultGroups.has(`${track.type}:${track.purpose}`) ? false : track.is_default,
        })),
        ...prioritizedTracks,
    ];
    const compositionError = validateMediaComposition(media.type, effectiveTracks);
    if (compositionError) {
        return c.json(error(Code.INVALID_PARAMETER, compositionError), 400);
    }

    const draftIds = tracks.map((t) => t.draft_file_id);
    const draftRows = await db
        .select({ draft: DraftFile, file: DbFile })
        .from(DraftFile)
        .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
        .where(and(eq(DraftFile.library_id, media.library_id), eq(DraftFile.status, DraftFileStatus.DRAFT)));

    const activeDraftMap = new Map(
        draftRows.map(({ draft, file }) => [
            draft.id,
            {
                name: draft.original_name,
                mime_type: file.mime_type,
            },
        ]),
    );

    for (const draftId of draftIds) {
        if (!activeDraftMap.has(draftId)) {
            return c.json(error(Code.INVALID_PARAMETER, `Draft file ${draftId} is invalid or already consumed`), 400);
        }
    }

    const fileTypeError = validateDraftTrackFileTypes(
        [
            {
                type: media.type,
                tracks,
            },
        ],
        activeDraftMap,
    );
    if (fileTypeError) {
        return c.json(error(Code.INVALID_PARAMETER, fileTypeError), 400);
    }

    try {
        await db.transaction(async (tx) => {
            for (const track of prioritizedTracks) {
                const fileId = await consumeDraftFile(tx, track.draft_file_id, media.library_id);

                await TrackService.upsertTrack(
                    id,
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
        });
    } catch (e) {
        if (e instanceof DraftFileUnavailableError) {
            return c.json(error(Code.ALREADY_EXISTS, e.message), 409);
        }
        throw e;
    }

    return c.json(success(Code.SUCCESS, { success: true }));
});

export default router;
