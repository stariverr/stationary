import * as v from "valibot";

export enum Platform {
    XHS = "XHS",
    X = "X",
    DOUYIN = "DOUYIN",
    YOUTUBE = "YOUTUBE",
    TIKTOK = "TIKTOK",
    INSTAGRAM = "INSTAGRAM",
    INTERNAL = "INTERNAL",
    BILIBILI = "BILIBILI",
    UNKNOWN = "UNKNOWN",
}

export const PlatformSchema = v.enum_(Platform);

export const TrackTypeSchema = v.picklist(["IMAGE", "VIDEO", "AUDIO", "SUBTITLE"]);
export const TrackPurposeSchema = v.picklist(["CONTENT", "COVER", "THUMBNAIL", "PREVIEW"]);
export const TrackQualitySchema = v.picklist(["ORIGINAL", "HIGH", "MEDIUM", "LOW"]);

export const TrackSchema = v.object({
    id: v.optional(v.string()),
    url: v.string(),
    type: TrackTypeSchema,
    purpose: TrackPurposeSchema,
    is_original: v.boolean(),
    quality: TrackQualitySchema,
    priority: v.number(),
    metadata: v.record(v.string(), v.unknown()),
    mime_type: v.optional(v.nullable(v.string())),
});
export type Track = v.InferOutput<typeof TrackSchema>;

export const ApiPostMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.optional(v.string()),
    source: v.optional(v.string()),
    title: v.nullish(v.string()),
    description: v.nullish(v.string()),
    type: v.picklist(["IMAGE", "VIDEO", "LIVE_PHOTO", "AUDIO", "PDF"]),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    url: v.optional(v.nullable(v.string())),
    cover_url: v.optional(v.nullable(v.string())),
    tracks: v.array(TrackSchema),
});
export type ApiPostMedia = v.InferOutput<typeof ApiPostMediaSchema>;

export const PostListItemSchema = v.object({
    id: v.string(),
    eid: v.string(),
    title: v.string(),
    source: v.string(),
    tags: v.nullish(v.array(v.string())),
    author_name: v.string(),
    author_avatar_url: v.optional(v.nullable(v.string())),
    url: v.string(),
    create_time: v.nullish(v.string()),
    published_time: v.nullish(v.string()),
    media: v.array(ApiPostMediaSchema),
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
});
export type ApiPostListItem = v.InferOutput<typeof PostListItemSchema>;

export const PostDetailResponseBodySchema = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
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
    url: v.optional(v.nullable(v.string())),
    media: v.optional(v.array(ApiPostMediaSchema)),
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
});
export type ApiPostDetail = v.InferOutput<typeof PostDetailResponseBodySchema>;

// --- UI / Frontend Schemas ---

export const PostMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.optional(v.string()),
    source: v.optional(v.string()),
    title: v.nullish(v.string()),
    description: v.nullish(v.string()),
    type: v.picklist(["IMAGE", "VIDEO", "LIVE_PHOTO", "AUDIO", "PDF"]),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    cover_url: v.optional(v.nullable(v.string())),
    tracks: v.array(TrackSchema),

    // Mapped fields for UI
    url: v.nullable(v.string()),
    mime_type: v.optional(v.nullable(v.string())),
    live_url: v.nullable(v.string()),
    thumbnail: v.nullable(v.string()),
    poster: v.nullable(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    index: v.optional(v.number()),
});
export type PostMedia = v.InferOutput<typeof PostMediaSchema>;

export const PostSchema = v.object({
    id: v.string(),
    eid: v.string(),
    title: v.string(),
    description: v.optional(v.nullable(v.string())),
    source: v.string(),
    tags: v.optional(v.array(v.string())),
    author_name: v.optional(v.nullable(v.string())),
    author_avatar_url: v.optional(v.nullable(v.string())),
    author_external_id: v.optional(v.nullable(v.string())),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    media_count: v.optional(v.number()),
    url: v.optional(v.nullable(v.string())),
    media: v.optional(v.array(PostMediaSchema)),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),

    // Mapped fields for UI / Legacy compatibility
    platform: PlatformSchema,
    date: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    size: v.optional(v.string()),
    author: v.string(),
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    originalUrl: v.optional(v.string()),
});
export type Post = v.InferOutput<typeof PostSchema>;
