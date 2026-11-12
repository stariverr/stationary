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
export enum MediaType {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    LIVE_PHOTO = "LIVE_PHOTO",
    AUDIO = "AUDIO",
    PDF = "PDF",
}

/** What a file can be, judged from its name and MIME type before the server probes it. */
export enum FileCategory {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    AUDIO = "AUDIO",
    SUBTITLE = "SUBTITLE",
    PDF = "PDF",
}

export const SyncStatusSchema = v.picklist(["PENDING", "IN_PROGRESS", "COMPLETED", "FAILED"]);
export type SyncStatus = v.InferOutput<typeof SyncStatusSchema>;

export const PlaybackVideoSchema = v.object({
    id: v.string(),
    codec: v.string(),
    codec_string: v.nullable(v.string()),
    width: v.number(),
    height: v.number(),
    rotation: v.number(),
    frame_rate: v.nullable(v.number()),
});
export type PlaybackVideo = v.InferOutput<typeof PlaybackVideoSchema>;

export const PlaybackAudioTrackSchema = v.object({
    id: v.string(),
    codec: v.string(),
    codec_string: v.nullable(v.string()),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    channels: v.number(),
    /** Whether `direct_url` carries this track. */
    in_direct: v.boolean(),
    /** Whether the HLS and DASH manifests carry this track. */
    in_manifest: v.boolean(),
});
export type PlaybackAudioTrack = v.InferOutput<typeof PlaybackAudioTrackSchema>;

export const PlaybackCaptionSchema = v.object({
    id: v.string(),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    vtt_url: v.string(),
});
export type PlaybackCaption = v.InferOutput<typeof PlaybackCaptionSchema>;

/** How a VIDEO, AUDIO or LIVE_PHOTO media plays. The manifest URLs are relative signed API paths. */
export const MediaPlaybackSchema = v.object({
    direct_url: v.string(),
    direct_mime_type: v.string(),
    hls_url: v.nullable(v.string()),
    dash_url: v.nullable(v.string()),
    duration: v.nullable(v.number()),
    video: v.nullable(PlaybackVideoSchema),
    audio_tracks: v.array(PlaybackAudioTrackSchema),
    captions: v.array(PlaybackCaptionSchema),
});
export type MediaPlayback = v.InferOutput<typeof MediaPlaybackSchema>;

/** A file of a media as uploaded or imported; `kind` is null until the server has probed it. */
export const MediaOriginalSchema = v.object({
    id: v.string(),
    kind: v.nullable(v.picklist(["IMAGE", "PDF", "VIDEO", "AUDIO"])),
    url: v.nullable(v.string()),
    mime_type: v.nullable(v.string()),
    size: v.nullable(v.number()),
    status: SyncStatusSchema,
    last_error: v.nullable(v.string()),
});
export type MediaOriginal = v.InferOutput<typeof MediaOriginalSchema>;

export const MediaCaptionSchema = v.object({
    id: v.string(),
    origin: v.picklist(["FILE", "EMBEDDED"]),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    status: SyncStatusSchema,
    last_error: v.nullable(v.string()),
    vtt_url: v.nullable(v.string()),
});
export type MediaCaption = v.InferOutput<typeof MediaCaptionSchema>;

/** One system-generated preview image. */
export const PreviewImageSchema = v.object({
    url: v.string(),
    width: v.number(),
    height: v.number(),
});
export type PreviewImage = v.InferOutput<typeof PreviewImageSchema>;

/** The three preview sizes of a media item; a size is null until generated, after a failure, or when the media has no preview source. */
export const MediaPreviewsSchema = v.object({
    small: v.nullable(PreviewImageSchema),
    medium: v.nullable(PreviewImageSchema),
    large: v.nullable(PreviewImageSchema),
});
export type MediaPreviews = v.InferOutput<typeof MediaPreviewsSchema>;

/** The original cover of a VIDEO, AUDIO or PDF item: uploaded by the user or imported from the platform. */
export const MediaCoverSchema = v.object({
    url: v.string(),
});
export type MediaCover = v.InferOutput<typeof MediaCoverSchema>;

/** A media with its originals, captions and playback: the items of `/post/:id/media` and `/media/detail/:id`. */
export const MediaDetailSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.optional(v.string()),
    post_id: v.nullable(v.pipe(v.string(), v.uuid())),
    source: v.optional(v.string()),
    title: v.nullish(v.string()),
    description: v.nullish(v.string()),
    type: v.enum(MediaType),
    sort_order: v.number(),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.nullable(v.string())),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
    /** The main original: the image of an IMAGE or LIVE_PHOTO, the video, audio or PDF of the others. */
    url: v.nullable(v.string()),
    /** Displayed size, rotation applied. */
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    duration: v.nullable(v.number()),
    previews: MediaPreviewsSchema,
    cover: v.nullable(MediaCoverSchema),
    playback: v.nullable(MediaPlaybackSchema),
    originals: v.array(MediaOriginalSchema),
    captions: v.array(MediaCaptionSchema),
    position: v.number(),
});
export type MediaDetail = v.InferOutput<typeof MediaDetailSchema>;

/** What the media viewers need to show one item. */
export interface MediaViewerItem {
    id: string;
    type: MediaType;
    title?: string | null;
    url?: string | null;
    previews?: MediaPreviews;
    playback?: MediaPlayback | null;
    width?: number | null;
    height?: number | null;
}

export const ApiPostListItemMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    type: v.enum(MediaType),
    sort_order: v.number(),
    previews: MediaPreviewsSchema,
    url: v.nullable(v.string()),
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
    type: v.picklist(["TEXT", "MULTI_MEDIA"]),
    sync_status: v.optional(v.nullable(v.string())),
    last_error: v.optional(v.nullable(v.string())),
});
export type ApiPostDetail = v.InferOutput<typeof PostDetailResponseBodySchema>;

// --- UI / Frontend Schemas ---

export const PostMediaSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    type: v.enum(MediaType),
    sort_order: v.number(),
    previews: MediaPreviewsSchema,
    title: v.nullish(v.string()),
    // Read by post cards, but `/post/list` items do not carry them.
    sync_status: v.optional(v.nullable(v.string())),
    ai_status: v.optional(v.nullable(v.string())),
    ai_error: v.optional(v.nullable(v.string())),
    width: v.optional(v.number()),
    height: v.optional(v.number()),

    // Mapped fields for UI
    url: v.nullable(v.string()),
    thumbnail: v.nullable(v.string()),
    poster: v.nullable(v.string()),
    srcset: v.nullable(v.string()),
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

export const PostMediaPageSchema = v.object({
    list: v.array(MediaDetailSchema),
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
