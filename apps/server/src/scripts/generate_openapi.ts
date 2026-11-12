import * as v from "valibot";
import { toJsonSchema } from "@valibot/to-json-schema";
import { AssetOrigin, MediaType, PostSource, SyncStatus } from "@/db/schema";

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

const TrashListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    type: v.optional(v.picklist(["all", "post", "media"])),
    page: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(10), v.maxValue(100))),
    keyword: v.optional(v.string()),
    sort_by: v.optional(v.picklist(["recycle_time"])),
    sort_order: v.optional(v.picklist(["asc", "desc"])),
});

const TrashBatchActionSchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
});

const TrashEmptySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
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
    library_id: v.pipe(v.string(), v.uuid()),
});

const MediaUpdateInfoSchema = v.object({
    title: v.optional(v.pipe(v.string(), v.minLength(1))),
    description: v.optional(v.string()),
    published_time: FormTimestampSchema,
});

const MediaReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});

const PlaybackVideoResponseSchema = v.object({
    id: v.string(),
    codec: v.string(),
    codec_string: v.nullable(v.string()),
    width: v.number(),
    height: v.number(),
    rotation: v.nullable(v.number()),
    frame_rate: v.nullable(v.number()),
});

const PlaybackAudioTrackResponseSchema = v.object({
    id: v.string(),
    codec: v.string(),
    codec_string: v.nullable(v.string()),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    channels: v.nullable(v.number()),
    /** Whether hls_url and dash_url carry this track (docs/media_refactor.zh-Hans.md, 16). */
    in_direct: v.boolean(),
    in_manifest: v.boolean(),
});

const PlaybackCaptionResponseSchema = v.object({
    id: v.string(),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    vtt_url: v.string(),
});

/** How to play a media: direct play of its one original, or adaptive manifests over its streams. */
const MediaPlaybackResponseSchema = v.object({
    direct_url: v.nullable(v.string()),
    direct_mime_type: v.nullable(v.string()),
    hls_url: v.nullable(v.string()),
    dash_url: v.nullable(v.string()),
    duration: v.nullable(v.number()),
    video: v.nullable(PlaybackVideoResponseSchema),
    audio_tracks: v.array(PlaybackAudioTrackResponseSchema),
    captions: v.array(PlaybackCaptionResponseSchema),
});

const PreviewImageResponseSchema = v.nullable(v.object({ url: v.string(), width: v.number(), height: v.number() }));
const PreviewImagesResponseSchema = v.object({
    small: PreviewImageResponseSchema,
    medium: PreviewImageResponseSchema,
    large: PreviewImageResponseSchema,
});

const MediaOriginalResponseSchema = v.object({
    id: v.string(),
    kind: v.nullable(v.picklist(["IMAGE", "PDF", "VIDEO", "AUDIO"])),
    url: v.nullable(v.string()),
    mime_type: v.nullable(v.string()),
    size: v.nullable(v.number()),
    status: v.enum(SyncStatus),
    last_error: v.nullable(v.string()),
});

const MediaCaptionResponseSchema = v.object({
    id: v.string(),
    origin: v.enum(AssetOrigin),
    language: v.nullable(v.string()),
    label: v.nullable(v.string()),
    is_default: v.boolean(),
    status: v.enum(SyncStatus),
    last_error: v.nullable(v.string()),
    vtt_url: v.nullable(v.string()),
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
    width: v.nullable(v.number()),
    height: v.nullable(v.number()),
    duration: v.nullable(v.number()),
    previews: PreviewImagesResponseSchema,
    cover: v.nullable(v.object({ url: v.string() })),
    playback: v.nullable(MediaPlaybackResponseSchema),
    originals: v.array(MediaOriginalResponseSchema),
    captions: v.array(MediaCaptionResponseSchema),
    position: v.optional(v.pipe(v.number(), v.integer())),
    ai: v.optional(
        v.object({
            status: v.picklist(["PENDING", "COMPLETED", "FAILED"]),
            error: v.nullable(v.string()),
            result: v.nullable(
                v.object({
                    caption: v.string(),
                    tags: v.array(v.string()),
                    objects: v.array(v.string()),
                    colors: v.array(v.string()),
                    styles: v.array(v.string()),
                    scene: v.string(),
                    ocr_text: v.string(),
                    model: v.string(),
                    generated_time: v.nullable(v.string()),
                }),
            ),
        }),
    ),
    tags: v.optional(v.array(v.string())),
});

const mediaDetailOpenApiSchema = valibotToOpenApi(MediaDetailResponseSchema);

const AddOriginalSchema = v.object({
    draft_file_id: v.pipe(v.string(), v.uuid()),
    replaces: v.optional(v.pipe(v.string(), v.uuid())),
});

const AddCaptionSchema = v.object({
    draft_file_id: v.pipe(v.string(), v.uuid()),
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    is_default: v.optional(v.boolean()),
});

const TrackInfoPatchSchema = v.object({
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    is_default: v.optional(v.boolean()),
});

const IdResponseSchema = makeUnifiedSuccessResponse({ type: "object", properties: { id: { type: "string" } } });

// Task & Workflow schemas
const AuthorSchema = v.object({
    name: v.optional(v.string(), ""),
    short_id: v.optional(v.string()),
    external_id: v.optional(v.string()),
    avatar_file_url: v.optional(v.nullable(v.string())),
});

const ImportOriginalSchema = v.object({
    url: v.pipe(v.string(), v.minLength(1)),
    source_key: v.pipe(v.string(), v.minLength(1)),
    language: v.optional(v.nullable(v.string())),
    label: v.optional(v.nullable(v.string())),
    is_default: v.optional(v.boolean(), false),
});

const ImportCaptionSchema = ImportOriginalSchema;

const MediaItemSchema = v.object({
    external_id: v.pipe(v.string(), v.trim(), v.minLength(1)),
    title: v.optional(v.nullable(v.string())),
    description: v.optional(v.nullable(v.string())),
    type: v.enum(MediaType),
    originals: v.pipe(v.array(ImportOriginalSchema), v.minLength(1)),
    cover: v.optional(v.nullable(v.object({ url: v.pipe(v.string(), v.minLength(1)), source_key: v.pipe(v.string(), v.minLength(1)) }))),
    captions: v.optional(v.array(ImportCaptionSchema), []),
    tags: v.optional(v.array(v.string()), []),
    published_time: v.optional(v.string()),
    create_time: v.optional(v.string()),
});

const PostItemSchema = v.object({
    title: v.string(),
    url: v.optional(v.string()),
    description: v.optional(v.string(), ""),
    external_id: v.pipe(v.string(), v.trim(), v.minLength(1)),
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
});

const RetrySyncSchema = v.object({
    media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
    library_id: v.pipe(v.string(), v.uuid()),
});

const SweepStuckLibrarySchema = v.object({
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
                hasMore: { type: "boolean" },
                degraded: {
                    type: "array",
                    description: "AI channels that were skipped or failed; results may be incomplete when non-empty.",
                    items: {
                        type: "object",
                        properties: {
                            channel: { type: "string", enum: ["ai", "text_semantic", "visual_semantic", "rerank"] },
                            reason: { type: "string", description: "Error kind, e.g. CONFIGURATION, AUTHENTICATION, THROTTLED, TIMEOUT" },
                        },
                        required: ["channel", "reason"],
                    },
                },
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
        path: "/api/media/:id/regenerate-previews",
        method: "post",
        summary: "Render the previews of a Media again",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/regenerate-previews",
        method: "post",
        summary: "Render the previews of several Media again",
        tags: ["Media"],
        bodySchema: v.object({
            library_id: v.pipe(v.string(), v.uuid()),
            media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
            post_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/cover/presign-upload",
        method: "post",
        summary: "Presign the upload of a cover image (VIDEO, AUDIO and PDF media)",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: v.object({ fileName: v.string() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                url: { type: "string" },
                path: { type: "string" },
                bucket: { type: "string" },
                mime_type: { type: "string" },
                extension: { type: "string" },
            },
        }),
    },
    {
        path: "/api/media/:id/cover",
        method: "post",
        summary: "Set the cover of a Media to an uploaded image",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: v.object({
            file: v.object({
                path: v.string(),
                bucket: v.string(),
                mime_type: v.string(),
                extension: v.string(),
                size: v.pipe(v.number(), v.integer()),
            }),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/cover/delete",
        method: "post",
        summary: "Remove the cover of a Media",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/manifest.mpd",
        method: "get",
        summary: "MPEG-DASH manifest of a media that has adaptive playback",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: { type: "string", description: "DASH XML manifest" },
    },
    {
        path: "/api/media/:id/manifest.m3u8",
        method: "get",
        summary: "HLS master playlist of a media that has adaptive playback",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: { type: "string", description: "HLS master playlist" },
    },
    {
        path: "/api/media/:id/hls/:renditionId/manifest.m3u8",
        method: "get",
        summary: "HLS playlist of one stream or caption of the master playlist",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), renditionId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: { type: "string", description: "HLS media playlist" },
    },
    {
        path: "/api/media/:id/packaged/:streamId/init.mp4",
        method: "get",
        summary: "Init segment of a stream packaged at request time from a non-fragmented MP4, MOV or M4A",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), streamId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: { type: "string", format: "binary", description: "fMP4 init segment" },
    },
    {
        path: "/api/media/:id/packaged/:streamId/:segment.m4s",
        method: "get",
        summary: "Media segment of a stream packaged at request time; numbered from 0",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), streamId: v.pipe(v.string(), v.uuid()), segment: v.string() }),
        requiresAuth: true,
        responseSchema: { type: "string", format: "binary", description: "fMP4 media segment (moof + mdat)" },
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
        path: "/api/media/:id/originals/:originalId/download-url",
        method: "get",
        summary: "Get a short-lived URL that downloads an original as an attachment",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), originalId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: { url: { type: "string", format: "uri" } },
        }),
    },
    {
        path: "/api/media/:id/originals",
        method: "post",
        summary: "Add an original uploaded as a draft file, or replace one with it",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: AddOriginalSchema,
        requiresAuth: true,
        responseSchema: IdResponseSchema,
    },
    {
        path: "/api/media/:id/originals/:originalId/delete",
        method: "post",
        summary: "Delete an original, unless the media would be left incomplete",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), originalId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: IdResponseSchema,
    },
    {
        path: "/api/media/:id/captions",
        method: "post",
        summary: "Add a caption uploaded as a draft subtitle file",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: AddCaptionSchema,
        requiresAuth: true,
        responseSchema: IdResponseSchema,
    },
    {
        path: "/api/media/:id/captions/:captionId/update",
        method: "post",
        summary: "Change a caption's language, label or default",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), captionId: v.pipe(v.string(), v.uuid()) }),
        bodySchema: TrackInfoPatchSchema,
        requiresAuth: true,
        responseSchema: IdResponseSchema,
    },
    {
        path: "/api/media/:id/captions/:captionId/delete",
        method: "post",
        summary: "Delete a caption",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), captionId: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: IdResponseSchema,
    },
    {
        path: "/api/media/:id/audio-tracks/:streamId/update",
        method: "post",
        summary: "Change an audio track's language or label, or make it the default",
        tags: ["Media"],
        paramSchema: v.object({ id: v.pipe(v.string(), v.uuid()), streamId: v.pipe(v.string(), v.uuid()) }),
        bodySchema: TrackInfoPatchSchema,
        requiresAuth: true,
        responseSchema: IdResponseSchema,
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
        path: "/api/ai/media/process",
        method: "post",
        summary: "Queue media, and the media of posts, for AI processing",
        tags: ["AI"],
        bodySchema: QueueAiSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/purge-expired-files",
        method: "post",
        summary: "Clean up deleted but expired files",
        tags: ["Task"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/purge-stale-pending-drafts",
        method: "post",
        summary: "Clean up pending uploads that were never confirmed",
        tags: ["Task"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/sweep-stuck-library",
        method: "post",
        summary: "Mark stuck sync items of a library as failed",
        tags: ["Task"],
        bodySchema: SweepStuckLibrarySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/sweep-stuck-tasks",
        method: "post",
        summary: "Clean up and recover stuck tasks",
        tags: ["Task"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/sweep-orphan-tags",
        method: "post",
        summary: "Clean up orphan tags under the media library",
        tags: ["Task"],
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    // Background pipelines (reconcile queue)
    {
        path: "/api/jobs/pipelines",
        method: "get",
        summary: "Whether a library is paused, and the queue and failure counts of its pipelines",
        tags: ["Jobs"],
        querySchema: v.object({ library_id: v.pipe(v.string(), v.uuid()) }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: { paused: { type: "boolean" }, pipelines: { type: "array", items: { type: "object" } } },
        }),
    },
    {
        path: "/api/jobs/pipelines/:library_id/paused",
        method: "put",
        summary: "Put the background work of a library on hold, or let it go on",
        tags: ["Jobs"],
        paramSchema: v.object({ library_id: v.pipe(v.string(), v.uuid()) }),
        bodySchema: v.strictObject({ paused: v.boolean() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object", properties: { paused: { type: "boolean" } } }),
    },
    {
        path: "/api/jobs/pipelines/:library_id/:pipeline/failures",
        method: "get",
        summary: "List the current failures of a pipeline",
        tags: ["Jobs"],
        paramSchema: v.object({ library_id: v.pipe(v.string(), v.uuid()), pipeline: v.string() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: { items: { type: "array", items: { type: "object" } } },
        }),
    },
    {
        path: "/api/jobs/pipelines/:library_id/:pipeline/retry-failed",
        method: "post",
        summary: "Queue every current failure of a pipeline again",
        tags: ["Jobs"],
        paramSchema: v.object({ library_id: v.pipe(v.string(), v.uuid()), pipeline: v.string() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
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
    // Trash / Recycle Bin
    {
        path: "/api/trash/list",
        method: "get",
        summary: "List all items in the recycle bin for a given library",
        tags: ["Trash"],
        querySchema: TrashListQuerySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                list: { type: "array", items: { type: "object" } },
                total: { type: "integer" },
                page: { type: "integer" },
                count: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/trash/restore",
        method: "post",
        summary: "Batch restore posts and media from the recycle bin",
        tags: ["Trash"],
        bodySchema: TrashBatchActionSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                restored_posts: { type: "integer" },
                restored_media: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/trash/delete",
        method: "post",
        summary: "Batch permanently delete posts and media from the recycle bin",
        tags: ["Trash"],
        bodySchema: TrashBatchActionSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                deleted_posts: { type: "integer" },
                deleted_media: { type: "integer" },
            },
        }),
    },
    {
        path: "/api/trash/empty",
        method: "post",
        summary: "Empty the entire recycle bin for a library",
        tags: ["Trash"],
        bodySchema: TrashEmptySchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({
            type: "object",
            properties: {
                deleted_posts: { type: "integer" },
                deleted_media: { type: "integer" },
            },
        }),
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
