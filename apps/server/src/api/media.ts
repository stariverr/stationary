import { Context, Hono } from "hono";
import { db } from "@/global/db";
import * as v from "valibot";
import { success, error, respondWithResult } from "@/lib/response";
import { Code } from "@/lib/code";
import {
    Media,
    Post,
    PostSource,
    DeleteStatus,
    AssetAiMetadata,
    EntityType,
    Tag,
    MediaTag,
    TagStatus,
    MediaType,
} from "@/db/schema";
import { s3 } from "@/global/s3";
import { and, eq, ilike, SQL, sql, count, asc, desc, or, isNull, inArray } from "drizzle-orm";

import { AuthEnv, ownedLibrary, requireAuth } from "@/lib/auth/middleware";
import { verifyMediaSignature } from "@/lib/utils/media-signer";
import { MediaService } from "@/features/media/queries";
import { v7 as uuidv7 } from "uuid";
import { env } from "@/global/env";
import { CoverNotAllowedError, CoverService } from "@/features/media/cover";
import { clearPreviews, loadPreviewImages, NO_PREVIEWS } from "@/features/media/preview";
import { COVER_MEDIA_TYPES } from "@/lib/validation/media-composition";
import { requeue } from "@/infra/queue/changes";
import { FormTimestampSchema, toIsoTimestamp } from "@/lib/utils/time";
import { getFileCategories, getFileExtension, getMimeTypeByExt } from "@/lib/utils/file";
import { validate } from "@/lib/validation/validator";
import { addCaption, addOriginal, deleteCaption, deleteOriginal, MediaEditError, updateAudioTrack, updateCaption } from "@/features/media/edit";
import { loadOriginalStates } from "@/features/media/originals";
import { mediaStoragePath } from "@/features/media/storage";
import { buildMediaDashManifest, buildMediaHlsMaster, buildMediaHlsRendition } from "@/features/playback/manifests";
import { readPackagedPart } from "@/features/playback/packaging";
import { deleteMedia, restoreMedia, trashMedia } from "@/features/media/lifecycle";
import { getMediaAiView, summarizeAiStatus } from "@/features/ai/media-view";
import { coverageFilter, getCoverageTargets } from "@/features/ai/coverage";
import { AiService } from "@/features/ai/service";
import { assertMediaAccess, MediaAccessError } from "@/features/media/access";
import { replaceMediaTags } from "@/features/media/tags";
import { updateMediaInfo } from "@/features/media/update-info";

const router = new Hono<AuthEnv>();

export const MediaListRequestBodySchema = v.object({
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
    sort_by: v.optional(v.picklist(["create_time", "published_time"])),
    sort_order: v.optional(v.picklist(["asc", "desc"])),
    type: v.optional(v.enum(MediaType)),
    display_mode: v.optional(v.picklist(["flat", "stacked"]), "flat"),
    library_id: v.pipe(v.string(), v.uuid()),
    has_no_post: v.optional(v.string()),
    /** Only items AI search does not cover yet, or cannot cover (see features/ai/coverage.ts). */
    ai_coverage: v.optional(v.picklist(["incomplete", "unprocessable"])),
});

// Media List - Cover-only media hydration (zero content track queries)
router.get("/list", requireAuth, validate("query", MediaListRequestBodySchema), async (c) => {
    const user = c.get("user");
    if (!user) {
        return c.json(error(Code.UNAUTHORIZED, "Unauthorized"), 401);
    }

    const query = c.req.valid("query");
    const page = query.page ?? 1;
    let pageSize = query.count ?? 20;
    if (pageSize > 100) {
        pageSize = 100;
    }
    const offset = (page - 1) * pageSize;
    const { keyword, source, sort_by, sort_order, type, display_mode, library_id, has_no_post, ai_coverage } = query;

    if (!(await ownedLibrary(c, user.id, library_id))) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const where: SQL[] = [eq(Media.library_id, library_id)];

    if (has_no_post === "true") {
        where.push(isNull(Media.post_id));
    }
    if (keyword) {
        where.push(or(ilike(Media.title, `%${keyword}%`), ilike(Media.description, `%${keyword}%`))!);
    }
    if (source) {
        where.push(eq(Media.source, source));
    }
    if (type) {
        where.push(eq(Media.type, type));
    }
    if (ai_coverage) {
        const targets = getCoverageTargets(await AiService.forLibrary(library_id));
        where.push(targets ? coverageFilter(targets, ai_coverage) : sql`false`);
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

    const isAsc = sort_order === "asc";
    const sortField = sort_by === "published_time" ? Media.published_time : Media.create_time;
    const orderClause = isAsc ? asc(sortField) : desc(sortField);

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
            display_width: Media.display_width,
            display_height: Media.display_height,
            duration: Media.duration,
        })
        .from(Media)
        .leftJoin(Post, eq(Media.post_id, Post.id))
        .where(visibleMediaFilter)
        .orderBy(orderClause)
        .limit(pageSize)
        .offset(offset);

    const mediaIds = rawMedia.map((m) => m.id);
    const [previewsByMediaId, mainUrls] = await Promise.all([loadPreviewImages(mediaIds), MediaService.getMainUrls(rawMedia)]);

    const aiRows =
        mediaIds.length > 0
            ? await db
                  .select({
                      entity_id: AssetAiMetadata.entity_id,
                      input_hash: AssetAiMetadata.input_hash,
                      last_error: AssetAiMetadata.last_error,
                  })
                  .from(AssetAiMetadata)
                  .where(and(inArray(AssetAiMetadata.entity_id, mediaIds), eq(AssetAiMetadata.entity_type, EntityType.MEDIA)))
            : [];

    const medias = rawMedia.map((m) => {
        const aiStatus = summarizeAiStatus(aiRows.find((row) => row.entity_id === m.id));

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
            ai_status: aiStatus.status,
            ai_error: aiStatus.error,
            url: mainUrls.get(m.id) ?? null,
            previews: previewsByMediaId.get(m.id) ?? NO_PREVIEWS,
            width: m.display_width,
            height: m.display_height,
            duration: m.duration,
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
            total: totalResult[0]?.total ?? 0,
        }),
    );
});

router.get("/detail/:id", requireAuth, async (c) => {
    const id = c.req.param("id")!;
    const access = await checkMediaAccess(c, id, true);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const mediaTagsList = await db
        .select({ name: Tag.name })
        .from(MediaTag)
        .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
        .where(and(eq(MediaTag.media_id, media.id), eq(Tag.status, TagStatus.ACTIVE)))
        .orderBy(asc(MediaTag.id));
    const mediaTags = mediaTagsList.map((mt) => mt.name);

    const [mediaDetail, ai] = await Promise.all([MediaService.getDetail(media), getMediaAiView(media.id)]);

    const response = {
        ...mediaDetail,
        ai,
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

    const result = await trashMedia(id);
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

    const result = await restoreMedia(id);
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

    const result = await deleteMedia(id);
    if (result.mediaUpdated === 0) {
        return c.json(error(Code.NOT_FOUND, "Media not found"), 404);
    }

    return c.json(success(Code.SUCCESS, result));
});
const MediaIdParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid("Invalid media ID format")),
});

/** Renders the media's previews again from scratch. */
router.post("/:id/regenerate-previews", requireAuth, validate("param", MediaIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    await db.transaction(async (tx) => {
        await clearPreviews(tx, [id]);
        await requeue(tx, ["preview"], [id]);
    });
    return c.json(success(Code.SUCCESS, { mediaId: id, status: "queued" }));
});

export const BatchRegeneratePreviewsSchema = v.pipe(
    v.object({
        library_id: v.pipe(v.string(), v.uuid("Invalid library_id format")),
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid media_id format")))),
        post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid("Invalid post_id format")))),
    }),
    v.check(
        (data) => (data.media_ids?.length || 0) + (data.post_ids?.length || 0) > 0,
        "Either media_ids or post_ids must be provided and cannot be empty",
    ),
);

router.post("/regenerate-previews", requireAuth, validate("json", BatchRegeneratePreviewsSchema), async (c) => {
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

    const library = await ownedLibrary(c, user.id, library_id);
    if (!library) {
        return c.json(error(Code.NOT_FOUND, "Library not found"), 404);
    }

    const filters: SQL[] = [];
    if (uniqueMediaIds.length > 0) {
        filters.push(inArray(Media.id, uniqueMediaIds));
    }
    if (uniquePostIds.length > 0) {
        filters.push(inArray(Media.post_id, uniquePostIds));
    }

    const mediaList = await db
        .select({ id: Media.id })
        .from(Media)
        .where(
            and(eq(Media.library_id, library_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time), or(...filters)),
        );

    if (mediaList.length === 0) {
        return c.json(error(Code.NOT_FOUND, "No matching media items found in the specified library"), 404);
    }

    if (uniqueMediaIds.length > 0) {
        const foundMediaIds = new Set(mediaList.map((m) => m.id));
        if (uniqueMediaIds.some((id) => !foundMediaIds.has(id))) {
            return c.json(error(Code.INVALID_PARAMETER, "All specified media items must belong to the specified library"), 400);
        }
    }

    const mediaIds = mediaList.map((m) => m.id);
    await db.transaction(async (tx) => {
        await clearPreviews(tx, mediaIds);
        await requeue(tx, ["preview"], mediaIds);
    });

    return c.json(success(Code.SUCCESS, { queued_media_count: mediaIds.length }));
});

const CoverPresignSchema = v.object({
    fileName: v.pipe(v.string(), v.nonEmpty("fileName is required")),
});

router.post("/:id/cover/presign-upload", requireAuth, validate("param", MediaIdParamSchema), validate("json", CoverPresignSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { fileName } = c.req.valid("json");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    if (!COVER_MEDIA_TYPES.has(media.type)) {
        return c.json(error(Code.INVALID_PARAMETER, `${media.type} media cannot have a cover`), 400);
    }
    if (!getFileCategories(fileName).includes("IMAGE")) {
        return c.json(error(Code.INVALID_PARAMETER, `${fileName} is not an image`), 400);
    }

    const ext = getFileExtension(fileName) || "bin";
    const path = mediaStoragePath(media, `cover_${uuidv7()}.${ext}`);
    const mimeType = getMimeTypeByExt(ext);
    const url = await s3.getUploadPresignedUrl(path, { bucket: env.S3_BUCKET, contentType: mimeType, expiresInSeconds: 3600 });

    return c.json(success(Code.SUCCESS, { url, path, bucket: env.S3_BUCKET, mime_type: mimeType, extension: ext }));
});

const SetCoverSchema = v.object({
    file: v.object({
        path: v.pipe(v.string(), v.nonEmpty()),
        bucket: v.pipe(v.string(), v.nonEmpty()),
        mime_type: v.pipe(v.string(), v.nonEmpty()),
        extension: v.pipe(v.string(), v.nonEmpty()),
        size: v.pipe(v.number(), v.integer(), v.minValue(0)),
    }),
});

/** Sets the cover to an image uploaded through `cover/presign-upload`. */
router.post("/:id/cover", requireAuth, validate("param", MediaIdParamSchema), validate("json", SetCoverSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { file } = c.req.valid("json");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    try {
        await db.transaction((tx) => CoverService.setUploaded(tx, media, file));
    } catch (e) {
        if (e instanceof CoverNotAllowedError) return c.json(error(Code.INVALID_PARAMETER, e.message), 400);
        throw e;
    }
    const cover = (await CoverService.loadUrls([id])).get(id) ?? null;
    return c.json(success(Code.SUCCESS, { cover }));
});

router.post("/:id/cover/delete", requireAuth, validate("param", MediaIdParamSchema), async (c) => {
    const { id } = c.req.valid("param");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const removed = await db.transaction((tx) => CoverService.remove(tx, id));
    if (!removed) return c.json(error(Code.NOT_FOUND, "Media has no cover"), 404);
    return c.json(success(Code.SUCCESS, { cover: null }));
});

const ManifestParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
});

const RenditionParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    renditionId: v.pipe(v.string(), v.uuid()),
});

const querySuffixOf = (c: Context) => {
    const query = new URLSearchParams(c.req.query()).toString();
    return query ? `?${query}` : undefined;
};

router.get("/:id/manifest.mpd", validate("param", ManifestParamSchema), async (c) => {
    const mediaId = c.req.valid("param").id;
    const access = await verifyMediaStreamAccess(c, mediaId);
    if (!access.ok) return access.errorResponse;

    const mpd = await buildMediaDashManifest(mediaId, querySuffixOf(c));
    if (!mpd) return c.json(error(Code.NOT_FOUND, "This media has no adaptive playback"), 404);
    c.header("Content-Type", "application/dash+xml");
    return c.text(mpd);
});

router.get("/:id/manifest.m3u8", validate("param", ManifestParamSchema), async (c) => {
    const mediaId = c.req.valid("param").id;
    const access = await verifyMediaStreamAccess(c, mediaId);
    if (!access.ok) return access.errorResponse;

    const m3u8 = await buildMediaHlsMaster(mediaId, querySuffixOf(c));
    if (!m3u8) return c.json(error(Code.NOT_FOUND, "This media has no adaptive playback"), 404);
    return c.newResponse(m3u8, 200, { "Content-Type": "application/x-mpegURL" });
});

/** The playlist of one stream or caption of the master playlist. */
router.get("/:id/hls/:renditionId/manifest.m3u8", validate("param", RenditionParamSchema), async (c) => {
    const { id: mediaId, renditionId } = c.req.valid("param");
    const access = await verifyMediaStreamAccess(c, mediaId, renditionId);
    if (!access.ok) return access.errorResponse;

    const m3u8 = await buildMediaHlsRendition(mediaId, renditionId, querySuffixOf(c));
    if (!m3u8) return c.json(error(Code.NOT_FOUND, "Rendition not found"), 404);
    return c.newResponse(m3u8, 200, { "Content-Type": "application/x-mpegURL" });
});

const PackagedParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    streamId: v.pipe(v.string(), v.uuid()),
    name: v.string(),
});

/**
 * An init segment (`init.mp4`) or media segment (`<n>.m4s`) packaged at request time (docs/media_refactor.zh-Hans.md,
 * 8.7). The bytes pass through the server; they never change for a stream, so clients may cache them.
 */
router.get("/:id/packaged/:streamId/:name", validate("param", PackagedParamSchema), async (c) => {
    const { id: mediaId, streamId, name } = c.req.valid("param");
    const segment = /^(\d{1,6})\.m4s$/.exec(name);
    if (name !== "init.mp4" && !segment) return c.json(error(Code.NOT_FOUND, "Segment not found"), 404);
    const access = await verifyMediaStreamAccess(c, mediaId, streamId);
    if (!access.ok) return access.errorResponse;

    const part = await readPackagedPart(mediaId, streamId, segment ? { kind: "segment", index: Number(segment[1]) } : { kind: "init" });
    if (!part) return c.json(error(Code.NOT_FOUND, "Segment not found"), 404);
    return c.newResponse(part.body as Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, 200, {
        "Content-Type": part.contentType,
        "Content-Length": String(part.size),
        "Cache-Control": "private, max-age=86400, immutable",
    });
});

async function verifyMediaStreamAccess(c: Context, mediaId: string, renditionId?: string): Promise<{ ok: boolean; errorResponse: any }> {
    const expires = c.req.query("expires");
    const sig = c.req.query("sig");

    // 1. Zero-DB HMAC Signature Check (Industry Standard Signed URL)
    if (expires && sig) {
        const isValid = verifyMediaSignature(mediaId, renditionId, expires, sig);
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
    allowRecycled = false,
): Promise<{ media: typeof Media.$inferSelect; errorResponse: null } | { media: null; errorResponse: any }> {
    return checkMediaOwnership(c, mediaId, allowRecycled);
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

    try {
        const media = await assertMediaAccess(
            mediaId,
            {
                ownerId: user.id,
                scopedLibraryId: c.get("apiToken")?.library_id,
            },
            { allowRecycled },
        );
        return { media, errorResponse: null };
    } catch (cause) {
        if (!(cause instanceof MediaAccessError)) throw cause;

        return { media: null, errorResponse: c.json(error(Code.NOT_FOUND, cause.message), 404) };
    }
}

const MediaUpdateInfoSchema = v.pipe(
    v.object({
        title: v.optional(v.pipe(v.string(), v.nonEmpty("Title cannot be empty"))),
        description: v.optional(v.string()),
        published_time: FormTimestampSchema,
    }),
    v.check((data) => Object.keys(data).length > 0, "At least one field must be provided for update"),
);

router.post("/update-info/:id", requireAuth, validate("json", MediaUpdateInfoSchema), async (c) => {
    const id = c.req.param("id")!;
    const body = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    const updated = await updateMediaInfo(id, body);
    return c.json(success(Code.SUCCESS, updated));
});

const MediaReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});

router.post("/:id/tags/replace", requireAuth, validate("json", MediaReplaceTagsSchema), async (c) => {
    const id = c.req.param("id")!;
    const { tags } = c.req.valid("json");

    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const resolvedTagIds = await replaceMediaTags(id, media.library_id, tags);
    return c.json(success(Code.SUCCESS, { tag_ids: resolvedTagIds }));
});

const DOWNLOAD_URL_TTL_SECONDS = 300;

const OriginalParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    originalId: v.pipe(v.string(), v.uuid()),
});
const CaptionParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    captionId: v.pipe(v.string(), v.uuid()),
});
const StreamParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    streamId: v.pipe(v.string(), v.uuid()),
});

function editErrorResponse(c: Context, cause: unknown) {
    if (!(cause instanceof MediaEditError)) throw cause;
    return c.json(error(cause.status === 404 ? Code.NOT_FOUND : Code.INVALID_PARAMETER, cause.message), cause.status);
}

/** A short-lived link that downloads an original under the media's title. */
router.get("/:id/originals/:originalId/download-url", requireAuth, validate("param", OriginalParamSchema), async (c) => {
    const { id, originalId } = c.req.valid("param");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;
    const media = access.media!;

    const state = ((await loadOriginalStates(db, [id])).get(id) ?? []).find((item) => item.original.id === originalId);
    const file = state?.file;
    if (!file) return c.json(error(Code.NOT_FOUND, "Original file not found"), 404);

    const extension = file.extension || getFileExtension(file.path);
    const baseName = media.title?.trim() || media.id;
    const downloadName = extension && !baseName.toLowerCase().endsWith(`.${extension}`) ? `${baseName}.${extension}` : baseName;
    const url = await s3.getPresignedUrl(file.path, { bucket: file.bucket, expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS, downloadName });
    return c.json(success(Code.SUCCESS, { url }));
});

const AddOriginalSchema = v.object({
    draft_file_id: v.pipe(v.string(), v.uuid()),
    /** The original the new file takes the place of. */
    replaces: v.optional(v.pipe(v.string(), v.uuid())),
});

/** Adds an original uploaded as a draft file, or replaces one with it. */
router.post("/:id/originals", requireAuth, validate("param", MediaIdParamSchema), validate("json", AddOriginalSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { draft_file_id, replaces } = c.req.valid("json");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        const originalId = await addOriginal(access.media!, draft_file_id, replaces);
        return c.json(success(Code.SUCCESS, { id: originalId }));
    } catch (cause) {
        return editErrorResponse(c, cause);
    }
});

router.post("/:id/originals/:originalId/delete", requireAuth, validate("param", OriginalParamSchema), async (c) => {
    const { id, originalId } = c.req.valid("param");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        await deleteOriginal(access.media!, originalId);
        return c.json(success(Code.SUCCESS, { id: originalId }));
    } catch (cause) {
        return editErrorResponse(c, cause);
    }
});

const NullableTextSchema = v.optional(v.nullable(v.pipe(v.string(), v.trim(), v.maxLength(100))));

const AddCaptionSchema = v.object({
    draft_file_id: v.pipe(v.string(), v.uuid()),
    language: NullableTextSchema,
    label: NullableTextSchema,
    is_default: v.optional(v.boolean()),
});

/** Adds a caption uploaded as a draft subtitle file. */
router.post("/:id/captions", requireAuth, validate("param", MediaIdParamSchema), validate("json", AddCaptionSchema), async (c) => {
    const { id } = c.req.valid("param");
    const { draft_file_id, ...declared } = c.req.valid("json");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        const captionId = await addCaption(access.media!, draft_file_id, declared);
        return c.json(success(Code.SUCCESS, { id: captionId }));
    } catch (cause) {
        return editErrorResponse(c, cause);
    }
});

const TrackInfoPatchSchema = v.pipe(
    v.object({
        language: NullableTextSchema,
        label: NullableTextSchema,
        is_default: v.optional(v.boolean()),
    }),
    v.check((data) => Object.keys(data).length > 0, "At least one field must be provided for update"),
);

router.post(
    "/:id/captions/:captionId/update",
    requireAuth,
    validate("param", CaptionParamSchema),
    validate("json", TrackInfoPatchSchema),
    async (c) => {
        const { id, captionId } = c.req.valid("param");
        const access = await checkMediaAccess(c, id);
        if (access.errorResponse) return access.errorResponse;

        try {
            await updateCaption(access.media!, captionId, c.req.valid("json"));
            return c.json(success(Code.SUCCESS, { id: captionId }));
        } catch (cause) {
            return editErrorResponse(c, cause);
        }
    },
);

router.post("/:id/captions/:captionId/delete", requireAuth, validate("param", CaptionParamSchema), async (c) => {
    const { id, captionId } = c.req.valid("param");
    const access = await checkMediaAccess(c, id);
    if (access.errorResponse) return access.errorResponse;

    try {
        await deleteCaption(access.media!, captionId);
        return c.json(success(Code.SUCCESS, { id: captionId }));
    } catch (cause) {
        return editErrorResponse(c, cause);
    }
});

/** Renames an audio track or makes it the default one. */
router.post(
    "/:id/audio-tracks/:streamId/update",
    requireAuth,
    validate("param", StreamParamSchema),
    validate("json", TrackInfoPatchSchema),
    async (c) => {
        const { id, streamId } = c.req.valid("param");
        const access = await checkMediaAccess(c, id);
        if (access.errorResponse) return access.errorResponse;

        try {
            await updateAudioTrack(access.media!, streamId, c.req.valid("json"));
            return c.json(success(Code.SUCCESS, { id: streamId }));
        } catch (cause) {
            return editErrorResponse(c, cause);
        }
    },
);

export default router;
