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
} from "@/db/schema";
import { s3 } from "@/global/s3";
import { and, eq, ilike, SQL, count, asc, desc, or, isNull, inArray } from "drizzle-orm";
import { AuthEnv, requireAuth } from "@/lib/auth/middleware";
import { RecycleService } from "@/services/recycle";
import { DeleteService } from "@/services/delete";
import { MediaService } from "@/services/media";
import { TrackService } from "@/services/track";
import { v7 as uuidv7 } from "uuid";
import { env } from "@/global/env";
import { VideoCoverService } from "@/services/video_cover";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { normalizeVariantKey } from "@/lib/utils/track";
import { Quality } from "@/lib/types";
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
import { getMediaCoversMap, formatListPreviews, getMediaTracks, formatMediaDetail } from "@/lib/utils/media_mapper";

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
    const coversByMediaId = await getMediaCoversMap(mediaIds);

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
        const previews = formatListPreviews(covers);
        const aiMeta = aiMetadataMap.get(m.id);
        const coverUrl = covers[0]?.url || null;

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
            covers: previews.covers,
            videos: previews.videos,
            audios: previews.audios,
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

    const files = await getMediaTracks(media.id);

    const mediaTagsList = await db
        .select({ name: Tag.name })
        .from(MediaTag)
        .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
        .where(and(eq(MediaTag.media_id, media.id), eq(Tag.status, TagStatus.ACTIVE)))
        .orderBy(asc(MediaTag.id));
    const mediaTags = mediaTagsList.map((mt) => mt.name);

    const mediaDetail = formatMediaDetail(media, files);

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

router.post("/:id/regenerate-cover", requireAuth, async (c) => {
    const id = c.req.param("id");
    if (!id) {
        return c.json(error(Code.INVALID_PARAMETER, "media id is required"), 400);
    }

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    if (media.type !== "VIDEO") {
        return c.json(error(Code.INVALID_PARAMETER, "Media is not a video"), 400);
    }

    let body: { replace_external_cover?: boolean } = {};
    try {
        body = await c.req.json();
    } catch {
        // Safe fallback for empty body
    }

    const url = new URL(c.req.url);
    const origin =
        env.UPSTASH_WORKFLOW_URL ||
        (c.req.header("x-forwarded-proto") ? `${c.req.header("x-forwarded-proto")}://${c.req.header("host")}` : url.origin);

    const res = await VideoCoverService.requestForMedia(id, {
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

    const asyncResults = await Promise.allSettled(
        mediaList.map(async (media) => {
            if (media.type !== "VIDEO") {
                return {
                    mediaId: media.id,
                    status: "skipped" as const,
                    reason: "media_not_video",
                };
            }
            const res = await VideoCoverService.requestForMedia(media.id, {
                originUrl: origin,
                force: true,
                replaceExternalCover: body.replace_external_cover ?? false,
            });
            return {
                mediaId: media.id,
                status: res.status,
                reason: res.status === "skipped" ? res.reason : undefined,
            };
        }),
    );

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

    for (let i = 0; i < asyncResults.length; i++) {
        const item = asyncResults[i];
        const media = mediaList[i];
        if (item.status === "fulfilled") {
            const val = item.value;
            if (val.status === "queued") queued++;
            else if (val.status === "skipped") skipped++;
            else if (val.status === "already_pending") alreadyPending++;
            results.push(val);
        } else {
            failed++;
            results.push({
                mediaId: media.id,
                status: "failed",
                error: item.reason?.message || String(item.reason),
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

router.get("/:id/manifest.mpd", requireAuth, validate("param", GetMpdRequestSchema), async (c) => {
    const mediaId = c.req.valid("param").id;
    const access = await checkMediaAccess(c, mediaId);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const tracks = await db
        .select()
        .from(Track)
        .where(
            and(eq(Track.media_id, media.id), eq(Track.delete_status, DeleteStatus.ACTIVE), eq(Track.sync_status, SyncStatus.COMPLETED)),
        );

    const selectVideoTrackId = c.req.query("video_track_id");
    const selectAudioTrackId = c.req.query("audio_track_id");

    let videoFiles = tracks.filter((t) => t.type === TrackType.VIDEO && t.purpose === TrackPurpose.CONTENT);
    let audioFiles = tracks.filter((t) => t.type === TrackType.AUDIO && t.purpose === TrackPurpose.CONTENT);

    if (selectVideoTrackId) {
        const filtered = videoFiles.filter((t) => t.id === selectVideoTrackId);
        if (filtered.length > 0) videoFiles = filtered;
    }
    if (selectAudioTrackId) {
        const filtered = audioFiles.filter((t) => t.id === selectAudioTrackId);
        if (filtered.length > 0) audioFiles = filtered;
    }

    if (videoFiles.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No video tracks found for this media"), 404);
    }

    const fileIds = tracks.map((t) => t.file_id).filter((fid): fid is string => !!fid);
    if (fileIds.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No physical files found for this media"), 404);
    }

    const physicalFiles = await db
        .select()
        .from(DbFile)
        .where(and(inArray(DbFile.id, fileIds), eq(DbFile.delete_status, DeleteStatus.ACTIVE)));

    const getPresignedUrlOrCdn = async (path: string, bucket: string) => {
        const cdnUrl = buildCdnUrl(bucket, path);
        if (cdnUrl) return cdnUrl;
        try {
            return await s3.getPresignedUrl(path, {
                bucket,
                expiresInSeconds: 3600 * 2,
            });
        } catch {
            return "";
        }
    };

    let mediaDuration = 0;

    const videoRepresentations = await Promise.all(
        videoFiles.map(async (vf) => {
            const file = physicalFiles.find((f) => f.id === vf.file_id);
            if (!file) return null;

            if (file.duration && file.duration > mediaDuration) {
                mediaDuration = file.duration;
            }

            const url = await getPresignedUrlOrCdn(file.path, file.bucket);
            const meta = vf.metadata;

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
            if (timescale !== undefined) segmentBaseAttrs.push(`timescale="${timescale}"`);
            if (pto !== undefined) segmentBaseAttrs.push(`presentationTimeOffset="${pto}"`);

            return `
      <Representation id="${escapeXml(normalizeVariantKey(vf.variant_key))}" codecs="${codecs}" bandwidth="${bandwidth}" width="${width}" height="${height}">
        <BaseURL>${escapeXml(url)}</BaseURL>
        <SegmentBase ${segmentBaseAttrs.join(" ")}>
          <Initialization range="${initRange}" />
        </SegmentBase>
      </Representation>`;
        }),
    ).then((items) => items.filter((x): x is string => x !== null));

    const audioRepresentations = await Promise.all(
        audioFiles.map(async (af) => {
            const file = physicalFiles.find((f) => f.id === af.file_id);
            if (!file) return null;

            if (file.duration && file.duration > mediaDuration) {
                mediaDuration = file.duration;
            }

            const url = await getPresignedUrlOrCdn(file.path, file.bucket);
            const meta = af.metadata;
            let codecs = meta?.codecs || "mp4a.40.2";
            if (codecs === "aac") codecs = "mp4a.40.2";
            const bandwidth = meta?.bandwidth || 128000;
            const indexRange = meta?.segment_base?.index_range || "837-5000";
            const initRange = meta?.segment_base?.initialization || "0-836";

            const timescale = meta?.segment_base?.timescale;
            const pto = meta?.segment_base?.earliest_presentation_time;
            const segmentBaseAttrs: string[] = [`indexRange="${indexRange}"`];
            if (timescale !== undefined) segmentBaseAttrs.push(`timescale="${timescale}"`);
            if (pto !== undefined) segmentBaseAttrs.push(`presentationTimeOffset="${pto}"`);

            return `
      <Representation id="${escapeXml(normalizeVariantKey(af.variant_key))}" codecs="${codecs}" bandwidth="${bandwidth}">
        <BaseURL>${escapeXml(url)}</BaseURL>
        <SegmentBase ${segmentBaseAttrs.join(" ")}>
          <Initialization range="${initRange}" />
        </SegmentBase>
      </Representation>`;
        }),
    ).then((items) => items.filter((x): x is string => x !== null));

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
});

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
    is_stale: z.boolean().optional(),
    source_track_id: z.string().nullable().optional(),
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

router.post("/:id/tracks/upsert", requireAuth, validate("json", RegisterTrackSchema), async (c) => {
    const id = c.req.param("id")!;
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
});

router.post("/:id/tracks/:trackId/update", requireAuth, validate("json", UpdateTrackMetadataSchema), async (c) => {
    const id = c.req.param("id")!;
    const trackId = c.req.param("trackId")!;
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
