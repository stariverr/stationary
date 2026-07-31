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
export enum TrackType {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    AUDIO = "AUDIO",
    SUBTITLE = "SUBTITLE",
    PDF = "PDF",
}

export enum MediaType {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    LIVE_PHOTO = "LIVE_PHOTO",
    AUDIO = "AUDIO",
    PDF = "PDF",
}

export enum TrackPurpose {
    CONTENT = "CONTENT",
    COVER = "COVER",
    THUMBNAIL = "THUMBNAIL",
    PREVIEW = "PREVIEW",
}

export enum TrackQuality {
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}

export const TrackSchema = v.object({
    id: v.string(),
    file_id: v.nullish(v.string()),
    url: v.string(),
    type: v.enum(TrackType),
    purpose: v.enum(TrackPurpose),
    is_original: v.boolean(),
    quality: v.enum(TrackQuality),
    priority: v.number(),
    metadata: v.record(v.string(), v.unknown()),
    mime_type: v.nullish(v.string()),
    variant_key: v.optional(v.string()),
    is_default: v.optional(v.boolean()),
    is_primary: v.optional(v.boolean()),
    display_name: v.optional(v.nullable(v.string())),
    language: v.optional(v.nullable(v.string())),
    codec: v.optional(v.nullable(v.string())),
    is_stale: v.optional(v.boolean()),
});
export type Track = v.InferOutput<typeof TrackSchema>;

export const CoverVariantSchema = v.object({
    track_id: v.string(),
    url: v.string(),
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    status: v.picklist(["READY", "STALE"]),
});

export const CoverSourceSchema = v.object({
    track_id: v.string(),
    url: v.string(),
    quality: v.enum(TrackQuality),
});

export const ApiPostMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.optional(v.string()),
    source: v.optional(v.string()),
    title: v.nullish(v.string()),
    description: v.nullish(v.string()),
    type: v.enum(MediaType),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    url: v.optional(v.nullable(v.string())),
    cover_url: v.optional(v.nullable(v.string())),
    cover_source: v.optional(v.nullable(CoverSourceSchema)),
    cover_variants: v.optional(v.record(v.string(), CoverVariantSchema)),
    tracks: v.array(TrackSchema),
});
export type ApiPostMedia = v.InferOutput<typeof ApiPostMediaSchema>;

export const PreviewItemSchema = v.object({
    url: v.nullable(v.string()),
    type: v.enum(TrackType),
    quality: v.enum(TrackQuality),
    codec: v.nullable(v.string()),
});
export type PreviewItem = v.InferOutput<typeof PreviewItemSchema>;

export interface MediaViewerSubtitle {
    url: string;
    language: string;
    label: string;
    format: string;
}

export interface MediaViewerTrack {
    id?: string;
    url: string;
    type: string;
    purpose: string;
    is_default?: boolean;
    priority?: number;
    quality?: string;
    mime_type?: string | null;
    codec?: string | null;
    metadata?: Record<string, unknown>;
}

export interface MediaViewerItem {
    id: string;
    type: MediaType;
    title?: string | null;
    url?: string | null;
    cover_url?: string | null;
    live_url?: string | null;
    tracks?: MediaViewerTrack[];
    width?: number;
    height?: number;
    subtitles?: MediaViewerSubtitle[];
}

export const ApiPostListItemMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.optional(v.string()),
    source: v.optional(v.string()),
    title: v.nullish(v.string()),
    description: v.nullish(v.string()),
    type: v.enum(MediaType),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    cover_source: v.optional(v.nullable(CoverSourceSchema)),
    cover_variants: v.optional(v.record(v.string(), CoverVariantSchema)),
    covers: v.nullish(v.array(PreviewItemSchema)),
    videos: v.nullish(v.array(PreviewItemSchema)),
    audios: v.nullish(v.array(PreviewItemSchema)),
});
export type ApiPostListItemMedia = v.InferOutput<typeof ApiPostListItemMediaSchema>;

export const PostListItemSchema = v.object({
    id: v.string(),
    library_id: v.string(),
    eid: v.string(),
    title: v.string(),
    source: v.string(),
    tags: v.nullish(v.array(v.string())),
    author_name: v.string(),
    author_avatar_url: v.optional(v.nullable(v.string())),
    url: v.string(),
    create_time: v.nullish(v.string()),
    published_time: v.nullish(v.string()),
    media: v.array(ApiPostListItemMediaSchema),
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
});
export type ApiPostListItem = v.InferOutput<typeof PostListItemSchema>;

export const PostDetailResponseBodySchema = v.object({
    id: v.optional(v.pipe(v.string(), v.uuid())),
    library_id: v.optional(v.pipe(v.string(), v.uuid())),
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
    type: v.enum(MediaType),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    cover_url: v.optional(v.nullable(v.string())),
    tracks: v.optional(v.array(TrackSchema)),

    // Mapped fields for UI
    url: v.nullable(v.string()),
    mime_type: v.optional(v.nullable(v.string())),
    live_url: v.nullable(v.string()),
    thumbnail: v.nullable(v.string()),
    poster: v.nullable(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    index: v.optional(v.number()),
    srcset: v.optional(v.nullable(v.string())),
});
export type PostMedia = v.InferOutput<typeof PostMediaSchema>;

export const PostSchema = v.object({
    id: v.string(),
    library_id: v.string(),
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
    platform: v.enum(Platform),
    date: v.string(),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    size: v.optional(v.string()),
    author: v.string(),
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    originalUrl: v.optional(v.string()),
});
export type Post = v.InferOutput<typeof PostSchema>;

export const PostMediaSummarySchema = v.object({
    id: v.string(),
    type: v.enum(MediaType),
    title: v.nullish(v.string()),
    sort_order: v.number(),
    position: v.number(),
    cover_url: v.string(),
    tracks: v.array(TrackSchema),
});
export type PostMediaSummary = v.InferOutput<typeof PostMediaSummarySchema>;

export const PostMediaPageSchema = v.object({
    list: v.array(PostMediaSummarySchema),
    page: v.number(),
    limit: v.number(),
    total: v.number(),
    total_pages: v.number(),
});
export type PostMediaPage = v.InferOutput<typeof PostMediaPageSchema>;

export interface AttachMediaResult {
    success: boolean;
    attached: number;
    total: number;
}

export interface ReorderMediaResult {
    success: boolean;
}

export interface UnbindMediaResult {
    success: boolean;
    remaining: number;
}

export interface TrashMediaResult {
    mediaUpdated: number;
}
