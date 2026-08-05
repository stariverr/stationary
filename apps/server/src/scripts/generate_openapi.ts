import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { MediaType, PostSource, TrackType, TrackPurpose, TrackStreamLayout } from "@/db/schema";
import { Quality } from "@/lib/types";

// FormTimestampSchema helper
const FormTimestampSchema = v.optional(v.nullable(v.union([v.string(), v.number()])));

function cleanSchema(schema: any): any {
    if (!schema || typeof schema !== "object") return schema;

    const cleaned = Array.isArray(schema) ? [...schema] : { ...schema };

    if (Array.isArray(cleaned)) {
        return cleaned.map((item) => cleanSchema(item));
    }

    if ("$schema" in cleaned) {
        delete cleaned.$schema;
    }

    if ("~standard" in cleaned) {
        delete cleaned["~standard"];
    }

    // Convert anyOf [ { type: X }, { type: "null" } ] -> { type: X, nullable: true }
    if (cleaned.anyOf && Array.isArray(cleaned.anyOf)) {
        const nullIndex = cleaned.anyOf.findIndex((x: any) => x && (x.type === "null" || x.type === null));
        if (nullIndex !== -1 && cleaned.anyOf.length === 2) {
            const otherIndex = nullIndex === 0 ? 1 : 0;
            const otherSchema = cleaned.anyOf[otherIndex];
            const result = cleanSchema(otherSchema);
            result.nullable = true;
            return result;
        }
    }

    // Recursively clean keys
    for (const key of Object.keys(cleaned)) {
        cleaned[key] = cleanSchema(cleaned[key]);
    }

    return cleaned;
}

function valibotToOpenApi(schema: any): any {
    if (!schema) return undefined;

    try {
        const rawSchema = toJsonSchema(schema, { errorMode: "ignore" });
        return cleanSchema(rawSchema);
    } catch (e) {
        console.error("Failed to call toJsonSchema on schema", e);
    }

    return { type: "object" };
}

function makeUnifiedSuccessResponse(dataSchema: any) {
    return {
        type: "object",
        properties: {
            code: { type: "integer", example: 0, description: "Status code, 0 indicates success" },
            message: { type: "string", example: "success", description: "Status description" },
            data: dataSchema || { type: "object", nullable: true },
        },
        required: ["code", "message"],
    };
}

// Recreate Schemas to avoid db side-effects
const TokenCreateBodySchema = v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    library_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
    expires_in_seconds: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
});

const SearchQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    keyword: v.pipe(v.string(), v.trim()),
    source: v.optional(v.enum(PostSource)),
    media_type: v.optional(v.enum(MediaType)),
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 1),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 20),
});

const LibraryListQuerySchema = v.object({
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    keyword: v.optional(v.string()),
});

const LibraryCreateBodySchema = v.object({
    name: v.pipe(v.string(), v.minLength(1)),
    description: v.optional(v.string(), ""),
});

const LibraryUpdateBodySchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
});

const LibraryMoveItemsBodySchema = v.object({
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid())), []),
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid())), []),
    target_library_id: v.pipe(v.string(), v.uuid()),
});

const LibraryAiConfigSchema = v.object({
    ai_provider: v.optional(v.nullable(v.picklist(["gemini", "openai"]))),
    openai_api_key: v.optional(v.nullable(v.string())),
    openai_base_url: v.optional(v.nullable(v.string())),
    openai_model_embedding_text: v.optional(v.nullable(v.string())),
    openai_model_embedding_text_map_to: v.optional(v.nullable(v.string())),
    openai_model_embedding_image: v.optional(v.nullable(v.string())),
    openai_model_embedding_image_map_to: v.optional(v.nullable(v.string())),
    openai_model_describe_image: v.optional(v.nullable(v.string())),
    openai_model_describe_image_map_to: v.optional(v.nullable(v.string())),
    gemini_api_key: v.optional(v.nullable(v.string())),
    gemini_base_url: v.optional(v.nullable(v.string())),
});

const TagListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    status: v.optional(v.picklist(["ACTIVE", "CANDIDATE", "IGNORED"])),
});

const TagCreateBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    name: v.pipe(v.string(), v.minLength(1)),
    color: v.optional(v.string()),
});

const TagUpdateBodySchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.optional(v.pipe(v.string(), v.minLength(1))),
    color: v.optional(v.nullable(v.string())),
    status: v.optional(v.picklist(["ACTIVE", "CANDIDATE", "IGNORED"])),
});

const TagMergeBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    source_tag_id: v.pipe(v.string(), v.uuid()),
    target_tag_id: v.pipe(v.string(), v.uuid()),
    retain_as_alias: v.optional(v.boolean(), true),
});

const PostListRequestBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    keyword: v.optional(v.string()),
    source: v.optional(v.enum(PostSource)),
    sort_by: v.optional(v.picklist(["import_time", "published_time"])),
    sort_order: v.optional(v.picklist(["asc", "desc"])),
    author_ids: v.optional(v.string()),
    media_type: v.optional(v.enum(MediaType)),
    tag_ids: v.optional(v.string()),
});

const PostUpdateInfoSchema = v.object({
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    published_time: FormTimestampSchema,
    url: v.optional(v.nullable(v.union([v.pipe(v.string(), v.url()), v.literal("")]))),
});

const PostReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});

const PostAttachMediaSchema = v.object({
    media_ids: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1)),
});

const PostReorderMediaSchema = v.object({
    media_ids: v.pipe(v.array(v.pipe(v.string(), v.uuid())), v.minLength(1)),
});

const MediaListRequestBodySchema = v.object({
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    keyword: v.optional(v.string()),
    source: v.optional(v.enum(PostSource)),
    display_mode: v.optional(v.picklist(["flat", "stacked"]), "flat"),
    library_id: v.optional(v.pipe(v.string(), v.uuid())),
});

const MediaUpdateInfoSchema = v.object({
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    published_time: FormTimestampSchema,
});

const MediaReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});

const PresignUploadSchema = v.object({
    type: v.enum(TrackType),
    purpose: v.enum(TrackPurpose),
    quality: v.enum(Quality),
    priority: v.optional(v.pipe(v.number(), v.integer()), 0),
    fileName: v.pipe(v.string(), v.minLength(1)),
});

const TrackStreamSchema = v.object({
    index: v.pipe(v.number(), v.integer(), v.minValue(0)),
    id: v.optional(v.nullable(v.string())),
    type: v.picklist([TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE]),
    codec: v.optional(v.nullable(v.string())),
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    role: v.optional(v.nullable(v.string())),
    width: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    height: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    bandwidth: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
    channels: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    sample_rate: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    is_default: v.optional(v.boolean()),
});

const TrackFormatFields = {
    container: v.optional(v.nullable(v.string())),
    is_fragmented: v.optional(v.nullable(v.boolean())),
    stream_layout: v.optional(v.nullable(v.enum(TrackStreamLayout))),
    has_video: v.optional(v.nullable(v.boolean())),
    has_audio: v.optional(v.nullable(v.boolean())),
    streams: v.optional(v.nullable(v.array(TrackStreamSchema))),
};

const TrackFormatSchema = v.object(TrackFormatFields);

const TrackResponseSchema = v.object({
    id: v.string(),
    file_id: v.string(),
    url: v.string(),
    type: v.enum(TrackType),
    purpose: v.enum(TrackPurpose),
    is_original: v.boolean(),
    quality: v.enum(Quality),
    priority: v.pipe(v.number(), v.integer()),
    metadata: v.record(v.string(), v.unknown()),
    variant_key: v.string(),
    is_default: v.boolean(),
    is_primary: v.boolean(),
    display_name: v.nullable(v.string()),
    language: v.nullable(v.string()),
    codec: v.nullable(v.string()),
    is_stale: v.boolean(),
    mime_type: v.nullable(v.string()),
    extension: v.nullable(v.string()),
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    container: v.nullable(v.string()),
    is_fragmented: v.nullable(v.boolean()),
    stream_layout: v.nullable(v.enum(TrackStreamLayout)),
    has_video: v.boolean(),
    has_audio: v.boolean(),
    streams: v.array(TrackStreamSchema),
});

const PlaybackVariantResponseSchema = v.object({
    track_id: v.string(),
    url: v.string(),
    mime_type: v.nullable(v.string()),
    quality: v.string(),
    label: v.string(),
    codec: v.nullable(v.string()),
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    bandwidth: v.nullable(v.number()),
    frame_rate: v.nullable(v.number()),
});

const PlaybackAudioTrackResponseSchema = v.object({
    id: v.string(),
    track_id: v.string(),
    source: v.picklist(["INTERNAL", "EXTERNAL"]),
    stream_index: v.nullable(v.number()),
    url: v.nullable(v.string()),
    select_url: v.nullable(v.string()),
    mime_type: v.nullable(v.string()),
    language: v.nullable(v.string()),
    label: v.string(),
    role: v.nullable(v.string()),
    codec: v.nullable(v.string()),
    channels: v.nullable(v.number()),
    is_default: v.boolean(),
    selectable: v.boolean(),
});

const PlaybackSubtitleTrackResponseSchema = v.object({
    id: v.string(),
    track_id: v.string(),
    source: v.picklist(["INTERNAL", "EXTERNAL"]),
    stream_index: v.nullable(v.number()),
    url: v.nullable(v.string()),
    mime_type: v.nullable(v.string()),
    language: v.nullable(v.string()),
    label: v.string(),
    format: v.nullable(v.string()),
    selectable: v.boolean(),
});

const MediaPlaybackResponseSchema = v.object({
    url: v.nullable(v.string()),
    mime_type: v.nullable(v.string()),
    protocol: v.nullable(v.picklist(["DASH", "PROGRESSIVE"])),
    track_id: v.nullable(v.string()),
    variants: v.array(PlaybackVariantResponseSchema),
    capabilities: v.object({
        quality_switching: v.boolean(),
        audio_switching: v.boolean(),
        subtitle_switching: v.boolean(),
        protocol_supports_switching: v.boolean(),
    }),
    audio_tracks: v.array(PlaybackAudioTrackResponseSchema),
    subtitle_tracks: v.array(PlaybackSubtitleTrackResponseSchema),
});

const MediaDetailResponseSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    eid: v.string(),
    post_id: v.nullable(v.pipe(v.string(), v.uuid())),
    source: v.enum(PostSource),
    title: v.string(),
    description: v.string(),
    type: v.enum(MediaType),
    sort_order: v.pipe(v.number(), v.integer()),
    create_time: v.optional(v.string()),
    published_time: v.optional(v.string()),
    sync_status: v.string(),
    last_error: v.nullable(v.string()),
    url: v.nullable(v.string()),
    playback: v.nullable(MediaPlaybackResponseSchema),
    audio_tracks: v.array(PlaybackAudioTrackResponseSchema),
    subtitle_tracks: v.array(PlaybackSubtitleTrackResponseSchema),
    subtitles: v.array(
        v.object({
            url: v.string(),
            language: v.string(),
            label: v.string(),
            format: v.string(),
        }),
    ),
    cover_url: v.nullable(v.string()),
    cover_variants: v.record(
        v.string(),
        v.object({
            track_id: v.string(),
            url: v.nullable(v.string()),
            width: v.nullable(v.number()),
            height: v.nullable(v.number()),
            status: v.picklist(["READY", "STALE"]),
        }),
    ),
    covers: v.array(
        v.object({
            url: v.nullable(v.string()),
            quality: v.enum(Quality),
            codec: v.nullable(v.string()),
        }),
    ),
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    tracks: v.array(TrackResponseSchema),
    position: v.optional(v.pipe(v.number(), v.integer())),
    ai_status: v.optional(v.string()),
    ai_error: v.optional(v.nullable(v.string())),
    tags: v.optional(v.array(v.string())),
});

const mediaDetailOpenApiSchema = valibotToOpenApi(MediaDetailResponseSchema);
const trackResponseOpenApiSchema = valibotToOpenApi(TrackResponseSchema);

const RegisterTrackSchema = v.object({
    type: v.enum(TrackType),
    purpose: v.enum(TrackPurpose),
    quality: v.enum(Quality),
    priority: v.optional(v.pipe(v.number(), v.integer()), 0),
    source_url: v.optional(v.string()),
    metadata: v.optional(v.any()),
    variant_key: v.optional(v.string()),
    is_default: v.optional(v.boolean()),
    is_primary: v.optional(v.boolean()),
    display_name: v.optional(v.string()),
    language: v.optional(v.nullable(v.string())),
    codec: v.optional(v.nullable(v.string())),
    is_stale: v.optional(v.boolean()),
    source_track_id: v.optional(v.nullable(v.string())),
    ...TrackFormatFields,
    file: v.object({
        path: v.pipe(v.string(), v.minLength(1)),
        bucket: v.pipe(v.string(), v.minLength(1)),
        mime_type: v.pipe(v.string(), v.minLength(1)),
        extension: v.pipe(v.string(), v.minLength(1)),
        size: v.pipe(v.number(), v.integer(), v.minValue(0)),
        width: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
        height: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
        duration: v.optional(v.nullable(v.number())),
    }),
});

const ReplaceFileSchema = v.object({
    file: v.object({
        path: v.pipe(v.string(), v.minLength(1)),
        bucket: v.pipe(v.string(), v.minLength(1)),
        mime_type: v.pipe(v.string(), v.minLength(1)),
        extension: v.pipe(v.string(), v.minLength(1)),
        size: v.pipe(v.number(), v.integer(), v.minValue(0)),
        width: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
        height: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
        duration: v.optional(v.nullable(v.number())),
    }),
});

const UpdateTrackMetadataSchema = v.object({
    priority: v.optional(v.pipe(v.number(), v.integer())),
    quality: v.optional(v.enum(Quality)),
    display_name: v.optional(v.nullable(v.string())),
    variant_key: v.optional(v.string()),
    is_default: v.optional(v.boolean()),
    language: v.optional(v.nullable(v.string())),
    codec: v.optional(v.nullable(v.string())),
    is_stale: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
    source_track_id: v.optional(v.nullable(v.string())),
    ...TrackFormatFields,
});

// Task & Workflow schemas
const AuthorSchema = v.object({
    name: v.optional(v.string(), ""),
    short_id: v.optional(v.string()),
    external_id: v.optional(v.string()),
    avatar_file_url: v.optional(v.nullable(v.string())),
});

const SegmentBaseSchema = v.object({
    initialization: v.optional(v.nullable(v.string())),
    index_range: v.optional(v.nullable(v.string())),
});

const TrackMetadataSchema = v.object({
    codecs: v.optional(v.nullable(v.string())),
    bandwidth: v.optional(v.nullable(v.number())),
    width: v.optional(v.nullable(v.number())),
    height: v.optional(v.nullable(v.number())),
    duration: v.optional(v.nullable(v.number())),
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    format: v.optional(v.nullable(v.string())),
    type: v.optional(v.nullable(v.picklist(["mp4", "fmp4"]))),
    segment_base: v.optional(v.nullable(SegmentBaseSchema)),
});

const TrackSchema = v.object({
    url: v.string(),
    type: v.enum(TrackType),
    purpose: v.optional(v.enum(TrackPurpose), TrackPurpose.CONTENT),
    is_original: v.optional(v.boolean(), true),
    quality: v.optional(v.enum(Quality), Quality.HIGH),
    priority: v.optional(v.number(), 0),
    metadata: v.optional(v.nullable(TrackMetadataSchema)),
    ...TrackFormatFields,
});

const MediaItemSchema = v.object({
    external_id: v.optional(v.string()),
    title: v.optional(v.nullable(v.string())),
    description: v.optional(v.nullable(v.string())),
    type: v.enum(MediaType),
    tracks: v.optional(v.array(TrackSchema), []),
    tags: v.optional(v.array(v.string()), []),
    duration: v.optional(v.nullable(v.number())),
    published_time: v.optional(v.string()),
    create_time: v.optional(v.string()),
});

const PostItemSchema = v.object({
    title: v.string(),
    url: v.optional(v.string()),
    description: v.optional(v.string(), ""),
    external_id: v.optional(v.string(), ""),
    tags: v.optional(v.array(v.string()), []),
    author: AuthorSchema,
    platform: v.enum(PostSource),
    media: v.array(MediaItemSchema),
    published_time: v.optional(v.string()),
    create_time: v.optional(v.string()),
});

const CreateTaskSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    posts: v.array(PostItemSchema),
    media: v.array(MediaItemSchema),
    force: v.optional(v.boolean()),
});

const RetrySyncSchema = v.object({
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    library_id: v.pipe(v.string(), v.uuid()),
});

const QueueAiSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    entity_type: v.picklist(["post", "media"]),
    entity_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    force: v.optional(v.boolean()),
});

// Better Auth Schemas
const SignUpBodySchema = v.object({
    name: v.string(),
    email: v.pipe(v.string(), v.email()),
    password: v.pipe(v.string(), v.minLength(8)),
});

const SignInBodySchema = v.object({
    email: v.pipe(v.string(), v.email()),
    password: v.string(),
});

interface RouteItem {
    path: string;
    method: "get" | "post" | "delete" | "put";
    summary: string;
    description?: string;
    tags: string[];
    querySchema?: v.GenericSchema;
    bodySchema?: v.GenericSchema;
    paramSchema?: v.GenericSchema;
    responseSchema?: any;
    requiresAuth: boolean;
}

const routes: RouteItem[] = [
    // User
    {
        path: "/api/user/",
        method: "get",
        summary: "Get current logged-in user info",
        tags: ["User"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
                image: { type: "string", nullable: true },
                email: { type: "string", nullable: true },
            },
        }),
    },
    {
        path: "/api/user/tokens",
        method: "post",
        summary: "Create API access token (Token)",
        tags: ["User"],
        bodySchema: TokenCreateBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                id: { type: "string", format: "uuid" },
                name: { type: "string" },
                prefix: { type: "string" },
                first_four: { type: "string" },
                last_four: { type: "string" },
                token: { type: "string" },
                library_id: { type: "string", format: "uuid", nullable: true },
                expires_at: { type: "string", nullable: true },
                create_time: { type: "string" },
            },
        }),
    },
    {
        path: "/api/user/tokens",
        method: "get",
        summary: "List all API tokens of the current user",
        tags: ["User"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    prefix: { type: "string" },
                    first_four: { type: "string" },
                    last_four: { type: "string" },
                    library_id: { type: "string", format: "uuid", nullable: true },
                    last_used_at: { type: "string", nullable: true },
                    expires_at: { type: "string", nullable: true },
                    create_time: { type: "string" },
                },
            },
        }),
    },
    {
        path: "/api/user/tokens/:id",
        method: "delete",
        summary: "Revoke specified API token",
        tags: ["User"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                id: { type: "string", format: "uuid" },
            },
        }),
    },
    // Search
    {
        path: "/api/search/",
        method: "get",
        summary: "Hybrid search (keyword and vector search)",
        tags: ["Search"],
        querySchema: SearchQuerySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    // Library
    {
        path: "/api/library/list",
        method: "get",
        summary: "List current user's media libraries",
        tags: ["Library"],
        querySchema: LibraryListQuerySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/library/create",
        method: "post",
        summary: "Create a new media library",
        tags: ["Library"],
        bodySchema: LibraryCreateBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/library/update",
        method: "post",
        summary: "Update media library info",
        tags: ["Library"],
        bodySchema: LibraryUpdateBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/library/delete/:id",
        method: "post",
        summary: "Delete specified media library",
        tags: ["Library"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                libraryUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/library/move-items",
        method: "post",
        summary: "Move Post/Media items across libraries",
        tags: ["Library"],
        bodySchema: LibraryMoveItemsBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                posts: { type: "integer" },
                media: { type: "integer" },
                post_media: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/library/:id/ai-config",
        method: "get",
        summary: "Get AI embedding and description config for the media library",
        tags: ["Library"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                ai_provider: { type: "string" },
                openai_api_key: { type: "string", nullable: true },
                openai_base_url: { type: "string", nullable: true },
                openai_model_embedding_text: { type: "string", nullable: true },
                openai_model_embedding_text_map_to: { type: "string", nullable: true },
                openai_model_embedding_image: { type: "string", nullable: true },
                openai_model_embedding_image_map_to: { type: "string", nullable: true },
                openai_model_describe_image: { type: "string", nullable: true },
                openai_model_describe_image_map_to: { type: "string", nullable: true },
                gemini_api_key: { type: "string", nullable: true },
                gemini_base_url: { type: "string", nullable: true },
            },
        }),
    },
    {
        path: "/api/library/:id/ai-config",
        method: "post",
        summary: "Modify AI embedding and description config for the media library",
        tags: ["Library"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: LibraryAiConfigSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object", nullable: true }),
    },
    // Tag
    {
        path: "/api/tag/list",
        method: "get",
        summary: "List all tags under the media library (with stats and aliases)",
        tags: ["Tag"],
        querySchema: TagListQuerySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: { type: "string", format: "uuid" },
                    name: { type: "string" },
                    normalized_name: { type: "string" },
                    color: { type: "string", nullable: true },
                    status: { type: "string" },
                    source: { type: "string" },
                    canonical_tag_id: { type: "string", format: "uuid", nullable: true },
                    post_count: { type: "integer" },
                    media_count: { type: "integer" },
                    aliases: { type: "array", items: { type: "string" } },
                },
            },
        }),
    },
    {
        path: "/api/tag/create",
        method: "post",
        summary: "Create a new tag",
        tags: ["Tag"],
        bodySchema: TagCreateBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/tag/update",
        method: "post",
        summary: "Update tag attributes",
        tags: ["Tag"],
        bodySchema: TagUpdateBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/tag/delete/:id",
        method: "post",
        summary: "Delete tag",
        tags: ["Tag"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                tagDeleted: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/tag/merge",
        method: "post",
        summary: "Merge two tags",
        tags: ["Tag"],
        bodySchema: TagMergeBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object", nullable: true }),
    },
    // Post
    {
        path: "/api/post/list",
        method: "get",
        summary: "Query Post list with pagination",
        tags: ["Post"],
        querySchema: PostListRequestBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/post/authors",
        method: "get",
        summary: "Get author list in the media library",
        tags: ["Post"],
        querySchema: v.object({
            library_id: v.pipe(v.string(), v.uuid()),
            keyword: v.optional(v.string()),
            author_ids: v.optional(v.string()),
            platform: v.optional(v.enum(PostSource)),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "array", items: { type: "object" } }),
    },
    {
        path: "/api/post/detail/:id",
        method: "get",
        summary: "Get Post details",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/media",
        method: "get",
        summary: "List paginated media for a Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        querySchema: v.object({
            page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
            limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
            keyword: v.optional(v.string()),
            type: v.optional(v.enum(MediaType)),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: mediaDetailOpenApiSchema },
                page: { type: "integer" },
                limit: { type: "integer" },
                total: { type: "integer" },
                total_pages: { type: "integer" },
            },
            required: ["list", "page", "limit", "total", "total_pages"],
        }),
    },
    {
        path: "/api/post/trash/:id",
        method: "post",
        summary: "Move Post to trash",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                postUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/post/restore/:id",
        method: "post",
        summary: "Restore Post from trash",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                postUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/post/delete/:id",
        method: "post",
        summary: "Permanently delete Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                postDeleted: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/post/update-info/:id",
        method: "post",
        summary: "Update Post info (title, description, published time, etc.)",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: PostUpdateInfoSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/tags/replace",
        method: "post",
        summary: "Replace tags bound to Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: PostReplaceTagsSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                tag_ids: { type: "array", items: { type: "string" } },
            },
        }),
    },
    {
        path: "/api/post/:id/bind_media",
        method: "post",
        summary: "Associate physical media with Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: PostAttachMediaSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/media/reorder",
        method: "post",
        summary: "Reorder media items under Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: PostReorderMediaSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/media/:mediaId/remove",
        method: "post",
        summary: "Remove associated media from Post",
        tags: ["Post"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), mediaId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    // Media
    {
        path: "/api/media/list",
        method: "get",
        summary: "Query Media list with pagination",
        tags: ["Media"],
        querySchema: MediaListRequestBodySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/media/detail/:id",
        method: "get",
        summary: "Get Media details",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse(mediaDetailOpenApiSchema),
    },
    {
        path: "/api/media/trash/:id",
        method: "post",
        summary: "Move Media to trash",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                mediaUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/media/restore/:id",
        method: "post",
        summary: "Restore Media from trash",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                mediaUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/media/delete/:id",
        method: "post",
        summary: "Permanently delete Media and its files",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                mediaUpdated: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/media/:id/regenerate-cover",
        method: "post",
        summary: "Regenerate cover for video Media",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: v.object({ replace_external_cover: v.optional(v.boolean()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/regenerate-covers",
        method: "post",
        summary: "Batch regenerate video covers",
        tags: ["Media"],
        bodySchema: v.object({
            library_id: v.pipe(v.string(), v.uuid()),
            media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
            post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
            replace_external_cover: v.optional(v.boolean()),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/manifest.mpd",
        method: "get",
        summary: "Get MPEG-DASH MPD playlist for video",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: {
            type: "string",
            description: "DASH XML manifest file",
        },
    },
    {
        path: "/api/media/update-info/:id",
        method: "post",
        summary: "Update basic info of Media",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: MediaUpdateInfoSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tags/replace",
        method: "post",
        summary: "Replace tags bound to Media",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: MediaReplaceTagsSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                tag_ids: { type: "array", items: { type: "string" } },
            },
        }),
    },
    {
        path: "/api/media/:id/tracks",
        method: "get",
        summary: "List all playback tracks under Media",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "array", items: trackResponseOpenApiSchema }),
    },
    {
        path: "/api/media/:id/tracks/presign-upload",
        method: "post",
        summary: "Get S3 presigned URL for uploading track",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: PresignUploadSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                url: { type: "string", format: "uri" },
                path: { type: "string" },
                bucket: { type: "string" },
                mime_type: { type: "string" },
                extension: { type: "string" },
            },
        }),
    },
    {
        path: "/api/media/:id/tracks/upsert",
        method: "post",
        summary: "Register/replace specified track and associate physical file",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: RegisterTrackSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/replace-file",
        method: "post",
        summary: "Replace physical file association of specified track",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), trackId: v.pipe(v.string(), v.uuid()) }),
        bodySchema: ReplaceFileSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/delete",
        method: "post",
        summary: "Delete track record",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), trackId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/update",
        method: "post",
        summary: "Update track attributes",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), trackId: v.pipe(v.string(), v.uuid()) }),
        bodySchema: UpdateTrackMetadataSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    // Task
    {
        path: "/api/task/create",
        method: "post",
        summary: "Start batch data synchronization and import task",
        tags: ["Task"],
        bodySchema: CreateTaskSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/retry-sync",
        method: "post",
        summary: "Retry tasks that failed to synchronize",
        tags: ["Task"],
        bodySchema: RetrySyncSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/queue-ai",
        method: "post",
        summary: "Trigger AI embedding/tagging task",
        tags: ["Task"],
        bodySchema: QueueAiSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/purge-expired-files",
        method: "post",
        summary: "Clean up deleted but expired files",
        tags: ["Task"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/scan-missing-covers",
        method: "post",
        summary: "Scan videos with missing covers and re-enqueue",
        tags: ["Task"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/sweep-stuck-tasks",
        method: "post",
        summary: "Clean up and recover stuck tasks",
        tags: ["Task"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/sweep-orphan-tags",
        method: "post",
        summary: "Clean up orphan tags under the media library",
        tags: ["Task"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    // Background Jobs (AsyncTask / AsyncTaskUnit)
    {
        path: "/api/jobs/list",
        method: "get",
        summary: "List background tasks for library or user",
        tags: ["Jobs"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/jobs/:id",
        method: "get",
        summary: "Get background task status and details",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/jobs/:id/pause",
        method: "post",
        summary: "Pause running background task",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/jobs/:id/resume",
        method: "post",
        summary: "Resume paused background task",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/jobs/:id/cancel",
        method: "post",
        summary: "Cancel background task",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/jobs/:id/retry-failed",
        method: "post",
        summary: "Retry failed units of a background task",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/jobs/:id/items",
        method: "get",
        summary: "List units of a background task",
        tags: ["Jobs"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
            },
        }),
    },
    // Better Auth (Standard Endpoints mounted under /api/auth)
    {
        path: "/api/auth/sign-up/email",
        method: "post",
        summary: "Sign up with email and password",
        tags: ["Authentication"],
        bodySchema: SignUpBodySchema,
        requiresAuth: false,
        responseSchema: {
            type: "object",
            properties: {
                user: { type: "object" },
                session: { type: "object" },
            },
        },
    },
    {
        path: "/api/auth/sign-in/email",
        method: "post",
        summary: "Sign in with email and password",
        tags: ["Authentication"],
        bodySchema: SignInBodySchema,
        requiresAuth: false,
        responseSchema: {
            type: "object",
            properties: {
                user: { type: "object" },
                session: { type: "object" },
            },
        },
    },
    {
        path: "/api/auth/sign-out",
        method: "post",
        summary: "Safely sign out current account and invalidate session",
        tags: ["Authentication"],
        requiresAuth: false,
        responseSchema: {
            type: "object",
            properties: {
                success: { type: "boolean" },
            },
        },
    },
    {
        path: "/api/auth/get-session",
        method: "get",
        summary: "Get current session info",
        tags: ["Authentication"],
        requiresAuth: false,
        responseSchema: {
            type: "object",
            properties: {
                user: { type: "object", nullable: true },
                session: { type: "object", nullable: true },
            },
        },
    },
];

async function generateOpenApi() {
    const spec: any = {
        openapi: "3.0.0",
        info: {
            title: "Stationary Server API",
            description: "All API endpoints for the Stationary backend service, supporting export to tools like Apifox / Postman.",
            version: "1.0.0",
        },
        servers: [
            {
                url: "http://localhost:9400",
                description: "Local development server",
            },
        ],
        paths: {},
        components: {
            securitySchemes: {
                BearerAuth: {
                    type: "http",
                    scheme: "bearer",
                    description: "Authenticate requests using API token (Authorization: Bearer <token>)",
                },
                CookieAuth: {
                    type: "apiKey",
                    in: "cookie",
                    name: "better-auth.session-token",
                    description: "Authenticate requests using Better Auth session cookie",
                },
            },
        },
    };

    for (const route of routes) {
        // Convert path parameters from :param to {param}
        const openApiPath = route.path.replace(/:([a-zA-Z0-9_]+)/g, "{$1}");

        if (!spec.paths[openApiPath]) {
            spec.paths[openApiPath] = {};
        }

        const operation: any = {
            summary: route.summary,
            tags: route.tags,
            responses: {},
        };

        if (route.requiresAuth) {
            operation.security = [{ BearerAuth: [] }, { CookieAuth: [] }];
        }

        // Path parameters
        const pathParams: any[] = [];
        const matches = route.path.match(/:([a-zA-Z0-9_]+)/g);
        if (matches) {
            for (const match of matches) {
                const name = match.substring(1);
                pathParams.push({
                    name: name,
                    in: "path",
                    required: true,
                    schema: { type: "string" },
                });
            }
        }

        // Query parameters
        const queryParams: any[] = [];
        if (route.querySchema) {
            const openApiQuery = valibotToOpenApi(route.querySchema);
            if (openApiQuery && openApiQuery.properties) {
                for (const [key, prop] of Object.entries(openApiQuery.properties)) {
                    const isRequired = openApiQuery.required && openApiQuery.required.includes(key);
                    queryParams.push({
                        name: key,
                        in: "query",
                        required: !!isRequired,
                        schema: prop,
                    });
                }
            }
        }

        if (pathParams.length > 0 || queryParams.length > 0) {
            operation.parameters = [...pathParams, ...queryParams];
        }

        // Request body
        if (route.bodySchema) {
            const bodySpec = valibotToOpenApi(route.bodySchema);
            operation.requestBody = {
                required: true,
                content: {
                    "application/json": {
                        schema: bodySpec,
                    },
                },
            };
        }

        // Response
        if (route.responseSchema) {
            operation.responses["200"] = {
                description: "Success response",
                content: {
                    "application/json": {
                        schema: route.responseSchema,
                    },
                },
            };
        } else {
            operation.responses["200"] = {
                description: "Success response",
                content: {
                    "application/json": {
                        schema: makeUnifiedSuccessResponse({ type: "object", nullable: true }),
                    },
                },
            };
        }

        // 401 response for auth routes
        if (route.requiresAuth) {
            operation.responses["401"] = {
                description: "Unauthorized / Not logged in",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            properties: {
                                code: { type: "integer", example: 40101 },
                                message: { type: "string", example: "Unauthorized" },
                            },
                        },
                    },
                },
            };
        }

        spec.paths[openApiPath][route.method] = operation;
    }

    const outputPath = "./docs/openapi.json";
    await Bun.write(outputPath, JSON.stringify(spec, null, 2));
    console.log(`Successfully generated OpenAPI JSON spec to: ${outputPath}`);
}

await generateOpenApi();
