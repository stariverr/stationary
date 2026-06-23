import {
    pgTable,
    serial,
    text,
    pgEnum,
    integer,
    jsonb,
    uuid,
    boolean,
    uniqueIndex,
    index,
    customType,
    timestamp,
} from "drizzle-orm/pg-core";
import { v7 as createUuidV7 } from "uuid";
import { Temporal } from "@js-temporal/polyfill";
import { sql } from "drizzle-orm";

const uuidv7 = { generate: createUuidV7 };

export const temporal = customType<{
    data: Temporal.Instant;
    driverData: string; // 👈 改为 string，利用 ISO 8601 字符串保留微秒精度
}>({
    dataType() {
        return "timestamptz";
    },
    fromDriver(value: unknown) {
        // 驱动返回的可能是 Date 对象或 string，统一转成 ISO 字符串让 Temporal 解析
        const isoString = value instanceof Date ? value.toISOString() : String(value);
        return Temporal.Instant.from(isoString);
    },
    toDriver(value: Temporal.Instant) {
        // 直接输出带高精度的 ISO 字符串：'2026-05-24T14:28:08.564888Z'
        return value.toString();
    },
});

// Enums

/** Media Type
 *
 */
export enum MediaType {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    LIVE_PHOTO = "LIVE_PHOTO",
    AUDIO = "AUDIO",
    PDF = "PDF",
}
export const MediaTypeEnum = pgEnum("media_type", [MediaType.IMAGE, MediaType.VIDEO, MediaType.LIVE_PHOTO, MediaType.AUDIO, MediaType.PDF]);

export enum PostSource {
    UNKNOWN = "UNKNOWN",
    X = "X",
    XHS = "XHS",
    BILIBILI = "BILIBILI",
    DOUYIN = "DOUYIN",
    TIKTOK = "TIKTOK",
    INSTAGRAM = "INSTAGRAM",
}
export const PostSourceEnum = pgEnum("post_source", [
    PostSource.UNKNOWN,
    PostSource.X,
    PostSource.XHS,
    PostSource.BILIBILI,
    PostSource.DOUYIN,
    PostSource.TIKTOK,
    PostSource.INSTAGRAM,
]);

export enum SyncStatus {
    PENDING = "PENDING",
    IN_PROGRESS = "IN_PROGRESS",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
}
export const SyncStatusEnum = pgEnum("sync_status", [SyncStatus.PENDING, SyncStatus.IN_PROGRESS, SyncStatus.COMPLETED, SyncStatus.FAILED]);

export enum TrackType {
    IMAGE = "IMAGE",
    VIDEO = "VIDEO",
    AUDIO = "AUDIO",
    SUBTITLE = "SUBTITLE",
}
export const TrackTypeEnum = pgEnum("track_type", [TrackType.IMAGE, TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE]);

export enum TrackPurpose {
    CONTENT = "CONTENT",
    COVER = "COVER",
    THUMBNAIL = "THUMBNAIL",
    PREVIEW = "PREVIEW",
}
export const TrackPurposeEnum = pgEnum("track_purpose", [
    TrackPurpose.CONTENT,
    TrackPurpose.COVER,
    TrackPurpose.THUMBNAIL,
    TrackPurpose.PREVIEW,
]);

export enum TrackQuality {
    ORIGINAL = "ORIGINAL",
    HIGH = "HIGH",
    MEDIUM = "MEDIUM",
    LOW = "LOW",
}
export const TrackQualityEnum = pgEnum("track_quality", [TrackQuality.ORIGINAL, TrackQuality.HIGH, TrackQuality.MEDIUM, TrackQuality.LOW]);

export enum AccessRole {
    VIEWER = "VIEWER",
    EDITOR = "EDITOR",
    ADMIN = "ADMIN",
}
export const AccessRoleEnum = pgEnum("access_role", [AccessRole.VIEWER, AccessRole.EDITOR, AccessRole.ADMIN]);

/** Soft delete status enum
 * - `ACTIVE`: Not deleted
 * - `DELETED`: Soft deleted, but affiliated records may still exist
 * - `PURGED`: Soft deleted, and all affiliated records and objects are deleted
 */
export enum DeleteStatus {
    ACTIVE = "ACTIVE",
    DELETED = "DELETED",
    PURGED = "PURGED",
}
export const DeleteStatusEnum = pgEnum("delete_status", [DeleteStatus.ACTIVE, DeleteStatus.DELETED, DeleteStatus.PURGED]);

export enum TagStatus {
    ACTIVE = "ACTIVE",
    CANDIDATE = "CANDIDATE",
    IGNORED = "IGNORED",
}
export const TagStatusEnum = pgEnum("tag_status", [TagStatus.ACTIVE, TagStatus.CANDIDATE, TagStatus.IGNORED]);

export enum TagSource {
    SCRAPER = "SCRAPER",
    AI = "AI",
    USER = "USER",
    IMPORT = "IMPORT",
}
export const TagSourceEnum = pgEnum("tag_source", [TagSource.SCRAPER, TagSource.AI, TagSource.USER, TagSource.IMPORT]);

export const Author = pgTable(
    "author",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        library_id: uuid("library_id").notNull(),
        eid: text("eid").notNull().default(""),
        short_eid: text("short_eid").notNull().default(""),
        nickname: text("nickname").notNull().default(""),
        signature: text("signature").notNull().default(""),
        platform: PostSourceEnum("platform").notNull(),
        avatar_file_id: uuid("avatar_file_id"),
        /** Avatar Thumb Path */
        avatar_thumb_file_id: uuid("avatar_thumb_file_id"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
        delete_time: temporal("delete_time"),
        delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
    },
    (table) => [uniqueIndex("author_library_platform_eid_unique").on(table.library_id, table.platform, table.eid)],
);

export const Library = pgTable("library", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    description: text("description").notNull(),
    cover_file_id: uuid("cover_file_id"),
    /** 所属用户 */
    owner_id: uuid("owner_id").notNull(),
    /** 是否公开 */
    is_public: boolean("is_public").default(false).notNull(),
    ai_provider: text("ai_provider"),
    openai_api_key: text("openai_api_key"),
    openai_base_url: text("openai_base_url"),
    openai_model_embedding_text: text("openai_model_embedding_text"),
    openai_model_embedding_text_map_to: text("openai_model_embedding_text_map_to"),
    openai_model_embedding_image: text("openai_model_embedding_image"),
    openai_model_embedding_image_map_to: text("openai_model_embedding_image_map_to"),
    openai_model_describe_image: text("openai_model_describe_image"),
    openai_model_describe_image_map_to: text("openai_model_describe_image_map_to"),
    gemini_api_key: text("gemini_api_key"),
    gemini_base_url: text("gemini_base_url"),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
    delete_time: temporal("delete_time"),
    delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
});

/** User Group
 * - [Hard Delete]
 */
export const UserGroup = pgTable("user_group", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    description: text("description").default("").notNull(),
    owner_id: uuid("owner_id").notNull(),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

/** User Group Member
 * - [Hard Delete]
 */
export const UserGroupMember = pgTable("user_group_member", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    group_id: uuid("group_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: AccessRoleEnum("role").notNull().default(AccessRole.VIEWER),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

/** Library User Access
 * - [Hard Delete]
 */
export const LibraryUserAccess = pgTable("library_user_access", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    library_id: uuid("library_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: AccessRoleEnum("role").notNull().default(AccessRole.VIEWER),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

/** Library Group Access
 * - [Hard Delete]
 */
export const LibraryGroupAccess = pgTable("library_group_access", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    library_id: uuid("library_id").notNull(),
    group_id: uuid("group_id").notNull(),
    role: AccessRoleEnum("role").notNull().default(AccessRole.VIEWER),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

/** Post
 * - [Soft Delete]
 */
export const Post = pgTable(
    "post",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        source: PostSourceEnum("source").notNull().default(PostSource.UNKNOWN),
        eid: text("eid").notNull(),
        title: text("title").notNull(),
        description: text("description").notNull(),
        tags: jsonb("tags").$type<string[]>().default([]).notNull(),
        author_id: uuid("author_id"),
        author_name: text("author_name").default("").notNull(),
        /** Author's external id */
        author_external_id: text("author_external_id"),
        /** Original published time on the source platform */
        published_time: temporal("published_time"),
        media_count: integer("media_count").notNull(),
        /** Source Platform URL */
        url: text("url").default(""),
        sync_status: SyncStatusEnum("sync_status").default(SyncStatus.PENDING).notNull(),
        last_error: text("last_error"),
        workflow_run_id: text("workflow_run_id"),
        library_id: uuid("library_id").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
        delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
        delete_time: temporal("delete_time"),
        recycle_time: temporal("recycle_time"),
    },
    (table) => [
        uniqueIndex("post_source_eid_unique").on(table.source, table.eid),
        index("post_library_delete_time_idx").on(table.library_id, table.delete_time),
    ],
);

export const Tag = pgTable(
    "tag",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        name: text("name").notNull(),
        normalized_name: text("normalized_name").notNull(),
        canonical_tag_id: uuid("canonical_tag_id"),
        color: text("color"),
        library_id: uuid("library_id").notNull(),
        status: TagStatusEnum("status").default(TagStatus.CANDIDATE).notNull(),
        source: TagSourceEnum("source").default(TagSource.SCRAPER).notNull(),
        source_field: text("source_field"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [uniqueIndex("tag_library_norm_name_unique").on(table.library_id, table.normalized_name)],
);

export const PostTag = pgTable(
    "post_tag",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        post_id: uuid("post_id").notNull(),
        tag_id: uuid("tag_id").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [uniqueIndex("post_tag_post_tag_unique").on(table.post_id, table.tag_id)],
);

export const MediaTag = pgTable(
    "media_tag",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        tag_id: uuid("tag_id").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [uniqueIndex("media_tag_media_tag_unique").on(table.media_id, table.tag_id)],
);

// Media Model
export const Media = pgTable(
    "media",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        sort_order: integer("sort_order").notNull(),
        eid: text("eid").notNull(),
        /** Post ID
         * - Can be null, if media is dependent.
         */
        post_id: uuid("post_id"),
        library_id: uuid("library_id").notNull(),
        source: PostSourceEnum("source").notNull().default(PostSource.UNKNOWN),
        title: text("title").notNull(),
        description: text("description").notNull(),
        type: MediaTypeEnum("type").notNull(),
        /** Primary Media URL
         * @deprecated
         */
        primary_url: text("primary_url").default(""),
        /** Alternative Media URL
         * @deprecated
         */
        alternative_url: text("alternative_url").default(""),
        /** Live Photo Original URL
         * @deprecated
         */
        live_photo_url: text("live_photo_url").default(""),
        /** Video Cover URL
         * @deprecated
         */
        cover_url: text("cover_url").default(""),
        /** Original published time on the source platform */
        // TODO: Change it to not null
        published_time: temporal("published_time"),
        sync_status: SyncStatusEnum("sync_status").default(SyncStatus.PENDING).notNull(),
        last_error: text("last_error"),
        workflow_run_id: text("workflow_run_id"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
        delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
        delete_time: temporal("delete_time"),
        recycle_time: temporal("recycle_time"),
    },
    (table) => [
        uniqueIndex("media_post_sort_unique").on(table.post_id, table.sort_order),
        index("media_source_eid_idx").on(table.source, table.eid),
        index("media_library_delete_time_idx").on(table.library_id, table.delete_time),
        index("media_post_delete_time_idx").on(table.post_id, table.delete_time),
    ],
);

export interface VideoTrackMetadata {
    type?: "mp4" | "fmp4";
    codecs?: string;
    bandwidth?: number;
    width?: number;
    height?: number;
    duration?: number;
    segment_base?: {
        initialization?: string;
        index_range?: string;
        timescale?: number;
        earliest_presentation_time?: string;
    };
}

export interface AudioTrackMetadata {
    codecs?: string;
    bandwidth?: number;
    label?: string;
    duration?: number;
    segment_base?: {
        initialization?: string;
        index_range?: string;
        timescale?: number;
        earliest_presentation_time?: string;
    };
}

export interface SubtitleTrackMetadata {
    language?: string;
    label?: string;
    format?: string;
}

export interface CoverMetadata {
    primary_file_id?: string;
    seek_seconds?: number;
}

export type MediaFileMetadata = VideoTrackMetadata & AudioTrackMetadata & SubtitleTrackMetadata & CoverMetadata;

// Track Model
export const Track = pgTable(
    "track",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        /** File ID
         * - Can be null because the file does not exist at first.
         */
        file_id: uuid("file_id"),
        type: TrackTypeEnum("type").notNull(),
        purpose: TrackPurposeEnum("purpose").notNull(),
        is_original: boolean("is_original").default(true).notNull(),
        is_generated: boolean("is_generated").default(false).notNull(),
        quality: TrackQualityEnum("quality").notNull(),
        /** Sorting/fallback priority of Track Variant */
        priority: integer("priority").default(0).notNull(),
        source_url: text("source_url").default(""),
        sync_status: SyncStatusEnum("sync_status").default(SyncStatus.PENDING).notNull(),
        last_error: text("last_error"),
        metadata: jsonb("metadata").$type<MediaFileMetadata>().default({}).notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
        delete_time: temporal("delete_time"),
        delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
    },
    (table) => [uniqueIndex("track_media_type_purpose_priority_unique").on(table.media_id, table.type, table.purpose, table.priority)],
);

// External API Token
export const ExternalApiToken = pgTable("external_api_token", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull().default("st"),
    first_four: text("first_four").notNull().default(""),
    last_four: text("last_four").notNull().default(""),
    owner_id: uuid("owner_id").notNull(), // User.id (UUID)
    library_id: uuid("library_id"), // Optional scope limit to a single Library (UUID)
    last_use_time: temporal("last_use_time"),
    expire_time: temporal("expire_time"),
    revoke_time: temporal("revoke_time"),

    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

// Business User Table
export const User = pgTable("user", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    auth_id: text("auth_id").notNull(), // .references(() => BetterUser.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    image: text("image"),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time")
        .default(sql`now()`)
        .notNull(),
});

// Files (The physical assets in S3)
export const File = pgTable("file", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    // TODO: determine nullability
    hash: text("hash"), // SHA-256 for deduplication
    // TODO: determine nullability
    size: integer("size"),
    mime_type: text("mime_type").notNull(),
    // TODO: determine nullability
    extension: text("extension"),
    path: text("path").notNull().unique(), // Path in bucket
    bucket: text("bucket").notNull(),
    // TODO: determine nullability
    width: integer("width"), // Metadata for quick rendering
    // TODO: determine nullability
    height: integer("height"),
    // TODO: determine nullability
    duration: integer("duration"), // For videos
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
    delete_time: temporal("delete_time"),
});

// ==== Better Auth Tables: START ====

export const BetterUser = pgTable("better_user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull(),
    image: text("image"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    externalId: text("external_id"),
});

export const BetterSession = pgTable("better_session", {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull(), // .references(() => BetterUser.id),
});

export const BetterAccount = pgTable("better_account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull(), // .references(() => BetterUser.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
});

export const BetterVerification = pgTable("better_verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
});

// ==== Better Auth Tables: END ====

// ==== AI & Search Tables: START ====

// Generic unconstrained vector type for pgvector
export const genericVector = customType<{ data: number[] }>({
    dataType() {
        return "vector";
    },
    fromDriver(value: unknown) {
        if (typeof value === "string") {
            return value.slice(1, -1).split(",").map(Number);
        }
        return value as number[];
    },
    toDriver(value: number[]) {
        return `[${value.join(",")}]`;
    },
});

// Enums
export enum ModalityType {
    TEXT = "TEXT",
    IMAGE = "IMAGE",
    VIDEO_FRAME = "VIDEO_FRAME",
    AUDIO = "AUDIO",
}
export const ModalityEnum = pgEnum("modality_type", [ModalityType.TEXT, ModalityType.IMAGE, ModalityType.VIDEO_FRAME, ModalityType.AUDIO]);

// NOTE: Reserved for future vector space model migration and upgrade management. Currently unused.
export enum EmbeddingSpaceStatus {
    ACTIVE = "ACTIVE",
    DEPRECATED = "DEPRECATED",
    EXPERIMENTAL = "EXPERIMENTAL",
}
export const EmbeddingSpaceStatusEnum = pgEnum("embedding_space_status", [
    EmbeddingSpaceStatus.ACTIVE,
    EmbeddingSpaceStatus.DEPRECATED,
    EmbeddingSpaceStatus.EXPERIMENTAL,
]);

export enum EntityType {
    POST = "POST",
    MEDIA = "MEDIA",
}
export const EntityTypeEnum = pgEnum("entity_type", [EntityType.POST, EntityType.MEDIA]);

/** Kind of Embeddings Vector Space
 * - `TEXT`: Text-only Embeddings
 * - `MULTI_MODAL`: Embeddings for Multi-modal data
 */
export enum VectorSpaceKind {
    TEXT = "TEXT",
    MULTI_MODAL = "MULTI_MODAL",
}
export const VectorSpaceKindEnum = pgEnum("space_kind", [VectorSpaceKind.TEXT, VectorSpaceKind.MULTI_MODAL]);

export enum MetricType {
    COSINE = "COSINE",
    INNER_PRODUCT = "INNER_PRODUCT",
    L2 = "L2",
}
export const MetricTypeEnum = pgEnum("metric_type", [MetricType.COSINE, MetricType.INNER_PRODUCT, MetricType.L2]);

export enum EmbeddingRole {
    CONTENT_TEXT = "CONTENT_TEXT",
    AI_CAPTION = "AI_CAPTION",
    IMAGE_PRIMARY = "IMAGE_PRIMARY",
    VIDEO_KEYFRAME = "VIDEO_KEYFRAME",
    OCR_TEXT = "OCR_TEXT",
}
export const EmbeddingRoleEnum = pgEnum("embedding_role", [
    EmbeddingRole.CONTENT_TEXT,
    EmbeddingRole.AI_CAPTION,
    EmbeddingRole.IMAGE_PRIMARY,
    EmbeddingRole.VIDEO_KEYFRAME,
    EmbeddingRole.OCR_TEXT,
]);

export enum EmbeddingStatus {
    READY = "READY",
    STALE = "STALE",
    FAILED = "FAILED",
    DISABLED = "DISABLED",
}
export const EmbeddingStatusEnum = pgEnum("embedding_status", [
    EmbeddingStatus.READY,
    EmbeddingStatus.STALE,
    EmbeddingStatus.FAILED,
    EmbeddingStatus.DISABLED,
]);

export enum ProcessingStatus {
    PENDING = "PENDING",
    IN_PROGRESS = "IN_PROGRESS",
    COMPLETED = "COMPLETED",
    FAILED = "FAILED",
}
export const ProcessingStatusEnum = pgEnum("processing_status", [
    ProcessingStatus.PENDING,
    ProcessingStatus.IN_PROGRESS,
    ProcessingStatus.COMPLETED,
    ProcessingStatus.FAILED,
]);

// TODO: Reserved for future vector space upgrades, model migrations,
// and background re-indexing status management (e.g., ACTIVE -> DEPRECATED).
// Currently unused; space IDs and model metadata are derived dynamically in code.
export const EmbeddingSpace = pgTable("embedding_space", {
    id: text("id").primaryKey(), // e.g. "gemini:multimodal-embedding-004:1408:cosine:v1"
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    model_version: text("model_version").notNull(),
    dimension: integer("dimension").notNull(),
    space_kind: VectorSpaceKindEnum("space_kind").notNull(),
    metric: MetricTypeEnum("metric").notNull(),
    status: EmbeddingSpaceStatusEnum("status").default(EmbeddingSpaceStatus.ACTIVE).notNull(),
    config: jsonb("config").default({}).notNull(),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
});

export const AssetSearchDocument = pgTable(
    "asset_search_document",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        library_id: uuid("library_id").notNull(),
        entity_type: EntityTypeEnum("entity_type").notNull(),
        entity_id: uuid("entity_id").notNull(),
        source: text("source").notNull(),
        media_type: text("media_type"),
        title: text("title").notNull().default(""),
        content: text("content").notNull().default(""),
        tags: jsonb("tags").$type<string[]>().default([]).notNull(),
        ai_tags: jsonb("ai_tags").$type<string[]>().default([]).notNull(),
        author_name: text("author_name").default("").notNull(),
        published_time: temporal("published_time"),
        content_hash: text("content_hash").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [uniqueIndex("search_doc_entity_unique").on(table.entity_type, table.entity_id)],
);

export const AssetAiMetadata = pgTable(
    "asset_ai_metadata",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        library_id: uuid("library_id").notNull(),
        entity_type: EntityTypeEnum("entity_type").notNull(),
        entity_id: uuid("entity_id").notNull(),
        caption: text("caption").default("").notNull(),
        summary: text("summary").default("").notNull(),
        tags: jsonb("tags").$type<string[]>().default([]).notNull(),
        objects: jsonb("objects").$type<string[]>().default([]).notNull(),
        colors: jsonb("colors").$type<string[]>().default([]).notNull(),
        styles: jsonb("styles").$type<string[]>().default([]).notNull(),
        scene: text("scene").default("").notNull(),
        ocr_text: text("ocr_text").default("").notNull(),
        model: text("model").notNull(),
        metadata_pipeline_id: text("metadata_pipeline_id").notNull(),
        processing_status: ProcessingStatusEnum("processing_status").default(ProcessingStatus.PENDING).notNull(),
        last_error: text("last_error"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [uniqueIndex("ai_metadata_entity_pipeline_unique").on(table.entity_type, table.entity_id, table.metadata_pipeline_id)],
);

export const AssetEmbedding = pgTable(
    "asset_embedding",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        library_id: uuid("library_id").notNull(),
        entity_type: EntityTypeEnum("entity_type").notNull(),
        entity_id: uuid("entity_id").notNull(),
        document_id: uuid("document_id"),
        embedding_space_id: text("embedding_space_id").notNull(),
        embedding_role: EmbeddingRoleEnum("embedding_role").notNull(),
        input_modality: ModalityEnum("input_modality").notNull(),
        dimension: integer("dimension").notNull(),
        embedding: genericVector("embedding").notNull(),
        content_hash: text("content_hash").notNull(),
        source_file_id: uuid("source_file_id"),
        embedding_status: EmbeddingStatusEnum("embedding_status").default(EmbeddingStatus.READY).notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [
        uniqueIndex("asset_emb_unique").on(
            table.entity_type,
            table.entity_id,
            table.embedding_space_id,
            table.embedding_role,
            table.content_hash,
        ),
    ],
);

// ==== AI & Search Tables: END ====
