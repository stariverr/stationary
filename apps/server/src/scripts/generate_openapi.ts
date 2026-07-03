import { writeFileSync } from "fs";
import { z } from "zod";
import { MediaType, PostSource, TrackType, TrackPurpose, TrackQuality } from "@/db/schema";

// FormTimestampSchema helper
const FormTimestampSchema = z.string().or(z.number()).nullable().optional();

// Convert Zod to OpenAPI Schema using native toJSONSchema method of Zod v4
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
        const nullIndex = cleaned.anyOf.findIndex((x: any) => x && (x.type === "null" || x.type === null || x.type === "null"));
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

function zodToOpenApi(schema: any): any {
    if (!schema) return undefined;

    if (typeof schema.toJSONSchema === "function") {
        try {
            const rawSchema = schema.toJSONSchema();
            return cleanSchema(rawSchema);
        } catch (e) {
            console.error("Failed to call toJSONSchema on schema", e);
        }
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
const TokenCreateBodySchema = z.object({
    name: z.string().min(1),
    library_id: z.string().uuid().nullable().optional(),
    expires_in_seconds: z.number().int().positive().nullable().optional(),
});

const SearchQuerySchema = z.object({
    library_id: z.string().uuid(),
    keyword: z.string().trim(),
    source: z.nativeEnum(PostSource).optional(),
    media_type: z.nativeEnum(MediaType).optional(),
    page: z.number().int().positive().optional().default(1),
    count: z.number().int().positive().optional().default(20),
});

const LibraryListQuerySchema = z.object({
    page: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    keyword: z.string().optional(),
});

const LibraryCreateBodySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional().default(""),
});

const LibraryUpdateBodySchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
});

const LibraryMoveItemsBodySchema = z.object({
    post_ids: z.array(z.string().uuid()).default([]),
    media_ids: z.array(z.string().uuid()).default([]),
    target_library_id: z.string().uuid(),
});

const LibraryAiConfigSchema = z.object({
    ai_provider: z.enum(["gemini", "openai"]).nullable().optional(),
    openai_api_key: z.string().nullable().optional(),
    openai_base_url: z.string().nullable().optional(),
    openai_model_embedding_text: z.string().nullable().optional(),
    openai_model_embedding_text_map_to: z.string().nullable().optional(),
    openai_model_embedding_image: z.string().nullable().optional(),
    openai_model_embedding_image_map_to: z.string().nullable().optional(),
    openai_model_describe_image: z.string().nullable().optional(),
    openai_model_describe_image_map_to: z.string().nullable().optional(),
    gemini_api_key: z.string().nullable().optional(),
    gemini_base_url: z.string().nullable().optional(),
});

const TagListQuerySchema = z.object({
    library_id: z.string().uuid(),
    status: z.enum(["ACTIVE", "CANDIDATE", "IGNORED"]).optional(),
});

const TagCreateBodySchema = z.object({
    library_id: z.string().uuid(),
    name: z.string().min(1),
    color: z.string().optional(),
});

const TagUpdateBodySchema = z.object({
    id: z.string().uuid(),
    name: z.string().min(1).optional(),
    color: z.string().nullable().optional(),
    status: z.enum(["ACTIVE", "CANDIDATE", "IGNORED"]).optional(),
});

const TagMergeBodySchema = z.object({
    library_id: z.string().uuid(),
    source_tag_id: z.string().uuid(),
    target_tag_id: z.string().uuid(),
    retain_as_alias: z.boolean().default(true),
});

const PostListRequestBodySchema = z.object({
    library_id: z.string().uuid(),
    page: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    keyword: z.string().optional(),
    source: z.nativeEnum(PostSource).optional(),
    sort_by: z.enum(["import_time", "published_time"]).optional(),
    sort_order: z.enum(["asc", "desc"]).optional(),
    author_ids: z.string().optional(),
    media_type: z.nativeEnum(MediaType).optional(),
    tag_ids: z.string().optional(),
});

const PostUpdateInfoSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    published_time: FormTimestampSchema,
    url: z.string().url().or(z.literal("")).nullable().optional(),
});

const PostReplaceTagsSchema = z.object({
    tags: z.array(z.string()),
});

const PostAttachMediaSchema = z.object({
    media_ids: z.array(z.string().uuid()).min(1),
});

const PostReorderMediaSchema = z.object({
    media_ids: z.array(z.string().uuid()).min(1),
});

const MediaListRequestBodySchema = z.object({
    page: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
    keyword: z.string().optional(),
    source: z.nativeEnum(PostSource).optional(),
    display_mode: z.enum(["flat", "stacked"]).default("flat"),
    library_id: z.string().uuid().optional(),
});

const MediaUpdateInfoSchema = z.object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    published_time: FormTimestampSchema,
});

const MediaReplaceTagsSchema = z.object({
    tags: z.array(z.string()),
});

const PresignUploadSchema = z.object({
    type: z.nativeEnum(TrackType),
    purpose: z.nativeEnum(TrackPurpose),
    quality: z.nativeEnum(TrackQuality),
    priority: z.number().int().default(0),
    fileName: z.string().min(1),
});

const RegisterTrackSchema = z.object({
    type: z.nativeEnum(TrackType),
    purpose: z.nativeEnum(TrackPurpose),
    quality: z.nativeEnum(TrackQuality),
    priority: z.number().int().default(0),
    source_url: z.string().optional(),
    metadata: z.any().optional(),
    variant_key: z.string().optional(),
    is_default: z.boolean().optional(),
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

const UpdateTrackMetadataSchema = z.object({
    priority: z.number().int().optional(),
    quality: z.nativeEnum(TrackQuality).optional(),
    display_name: z.string().nullable().optional(),
    variant_key: z.string().optional(),
    is_default: z.boolean().optional(),
    language: z.string().nullable().optional(),
    codec: z.string().nullable().optional(),
    is_stale: z.boolean().optional(),
    metadata: z.any().optional(),
    source_track_id: z.string().nullable().optional(),
});

// Task & Workflow schemas
const AuthorSchema = z.object({
    name: z.string().default(""),
    short_id: z.string().optional(),
    external_id: z.string().optional(),
    avatar_file_url: z.string().nullable().optional(),
});

const SegmentBaseSchema = z.object({
    initialization: z.string().nullish(),
    index_range: z.string().nullish(),
});

const TrackMetadataSchema = z.object({
    codecs: z.string().nullish(),
    bandwidth: z.number().nullish(),
    width: z.number().nullish(),
    height: z.number().nullish(),
    duration: z.number().nullish(),
    language: z.string().nullish(),
    label: z.string().nullish(),
    format: z.string().nullish(),
    type: z.enum(["mp4", "fmp4"]).nullish(),
    segment_base: SegmentBaseSchema.nullish(),
});

const TrackSchema = z.object({
    url: z.string(),
    type: z.nativeEnum(TrackType),
    purpose: z.nativeEnum(TrackPurpose).default(TrackPurpose.CONTENT),
    is_original: z.boolean().default(true),
    quality: z.nativeEnum(TrackQuality).default(TrackQuality.ORIGINAL),
    priority: z.number().default(0),
    metadata: TrackMetadataSchema.nullish(),
});

const MediaItemSchema = z.object({
    external_id: z.string().optional(),
    title: z.string().nullish(),
    description: z.string().nullish(),
    type: z.nativeEnum(MediaType),
    tracks: z.array(TrackSchema).default([]),
    tags: z.array(z.string()).default([]),
    duration: z.number().nullable().optional(),
    published_time: z.string().optional(),
    create_time: z.string().optional(),
});

const PostItemSchema = z.object({
    title: z.string(),
    url: z.string().optional(),
    description: z.string().default(""),
    external_id: z.string().optional().default(""),
    tags: z.array(z.string()).default([]),
    author: AuthorSchema,
    platform: z.nativeEnum(PostSource),
    media: z.array(MediaItemSchema),
    published_time: z.string().optional(),
    create_time: z.string().optional(),
});

const CreateTaskSchema = z.object({
    library_id: z.string().uuid(),
    posts: z.array(PostItemSchema),
    media: z.array(MediaItemSchema),
    force: z.boolean().optional(),
});

const RetrySyncSchema = z.object({
    media_ids: z.array(z.string().uuid()).optional(),
    post_ids: z.array(z.string().uuid()).optional(),
    library_id: z.string().uuid(),
});

const QueueAiSchema = z.object({
    library_id: z.string().uuid(),
    entity_type: z.enum(["post", "media"]),
    entity_ids: z.array(z.string().uuid()).optional(),
    force: z.boolean().optional(),
});

// Better Auth Schemas
const SignUpBodySchema = z.object({
    name: z.string(),
    email: z.string().email(),
    password: z.string().min(8),
});

const SignInBodySchema = z.object({
    email: z.string().email(),
    password: z.string(),
});

interface RouteItem {
    path: string;
    method: "get" | "post" | "delete" | "put";
    summary: string;
    description?: string;
    tags: string[];
    querySchema?: z.ZodObject<any>;
    bodySchema?: z.ZodTypeAny;
    paramSchema?: z.ZodObject<any>;
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        querySchema: z.object({
            library_id: z.string().uuid(),
            keyword: z.string().optional(),
            author_ids: z.string().optional(),
            platform: z.nativeEnum(PostSource).optional(),
        }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "array", items: { type: "object" } }),
    },
    {
        path: "/api/post/detail/:id",
        method: "get",
        summary: "Get Post details",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/trash/:id",
        method: "post",
        summary: "Move Post to trash",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: PostUpdateInfoSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/tags/replace",
        method: "post",
        summary: "Replace tags bound to Post",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        path: "/api/post/:id/media/attach",
        method: "post",
        summary: "Associate physical media with Post",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: PostAttachMediaSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/media/reorder",
        method: "post",
        summary: "Reorder media items under Post",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: PostReorderMediaSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/post/:id/media/:mediaId/remove",
        method: "post",
        summary: "Remove associated media from Post",
        tags: ["Post"],
        paramSchema: z.object({ id: z.string().uuid(), mediaId: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/trash/:id",
        method: "post",
        summary: "Move Media to trash",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: z.object({ replace_external_cover: z.boolean().optional() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/regenerate-covers",
        method: "post",
        summary: "Batch regenerate video covers",
        tags: ["Media"],
        bodySchema: z.object({ media_ids: z.array(z.string().uuid()), replace_external_cover: z.boolean().optional() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/manifest.mpd",
        method: "get",
        summary: "Get MPEG-DASH MPD playlist for video",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: MediaUpdateInfoSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tags/replace",
        method: "post",
        summary: "Replace tags bound to Media",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        paramSchema: z.object({ id: z.string().uuid() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "array", items: { type: "object" } }),
    },
    {
        path: "/api/media/:id/tracks/presign-upload",
        method: "post",
        summary: "Get S3 presigned URL for uploading track",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid() }),
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
        path: "/api/media/:id/tracks/add-or-replace",
        method: "post",
        summary: "Register/replace specified track and associate physical file",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid() }),
        bodySchema: RegisterTrackSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/replace-file",
        method: "post",
        summary: "Replace physical file association of specified track",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid(), trackId: z.string().uuid() }),
        bodySchema: ReplaceFileSchema,
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/delete",
        method: "post",
        summary: "Delete track record",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid(), trackId: z.string().uuid() }),
        requiresAuth: true,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/media/:id/tracks/:trackId/update",
        method: "post",
        summary: "Update track attributes",
        tags: ["Media"],
        paramSchema: z.object({ id: z.string().uuid(), trackId: z.string().uuid() }),
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
    // Workflows
    {
        path: "/api/task/workflow",
        method: "post",
        summary: "Upstash Workflow webhook endpoint for processing main task",
        tags: ["Workflow"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/workflow-cover",
        method: "post",
        summary: "Webhook endpoint for video cover extraction workflow",
        tags: ["Workflow"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/workflow-ai",
        method: "post",
        summary: "Webhook endpoint for AI vector/description workflow",
        tags: ["Workflow"],
        requiresAuth: false,
        responseSchema: makeUnifiedSuccessResponse({ type: "object" }),
    },
    {
        path: "/api/task/workflow-copy-avatar",
        method: "post",
        summary: "Webhook endpoint for cross-library avatar copy workflow",
        tags: ["Workflow"],
        requiresAuth: false,
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
];

function generateOpenApi() {
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
            const openApiQuery = zodToOpenApi(route.querySchema);
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
            const bodySpec = zodToOpenApi(route.bodySchema);
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
    writeFileSync(outputPath, JSON.stringify(spec, null, 2), "utf8");
    console.log(`Successfully generated OpenAPI JSON spec to: ${outputPath}`);
}

generateOpenApi();
