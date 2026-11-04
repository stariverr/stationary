import {
    pgTable,
    serial,
    text,
    pgEnum,
    integer,
    bigint,
    jsonb,
    uuid,
    boolean,
    uniqueIndex,
    index,
    check,
    customType,
    timestamp,
    varchar,
    real,
    smallint,
    primaryKey,
} from "drizzle-orm/pg-core";
import { v7 as createUuidV7 } from "uuid";

import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { Quality } from "@/lib/types";
import { AI_MODEL_CATEGORIES, EMBEDDING_DIMENSIONS } from "@/features/ai/model-schema";

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
    PDF = "PDF",
}
export const TrackTypeEnum = pgEnum("track_type", [TrackType.IMAGE, TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE, TrackType.PDF]);

export enum TrackStreamLayout {
    SINGLE = "SINGLE",
    MUXED = "MUXED",
    VIDEO_ONLY = "VIDEO_ONLY",
    AUDIO_ONLY = "AUDIO_ONLY",
    TEXT_ONLY = "TEXT_ONLY",
}
export const TrackStreamLayoutEnum = pgEnum("track_stream_layout", [
    TrackStreamLayout.SINGLE,
    TrackStreamLayout.MUXED,
    TrackStreamLayout.VIDEO_ONLY,
    TrackStreamLayout.AUDIO_ONLY,
    TrackStreamLayout.TEXT_ONLY,
]);

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

export const TrackQualityEnum = pgEnum("track_quality", [Quality.HIGH, Quality.MEDIUM, Quality.LOW]);

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
        /** Where the avatar should come from: a remote URL (ingest) or another author's file (move). At most one is set. */
        avatar_source_url: text("avatar_source_url"),
        avatar_source_file_id: uuid("avatar_source_file_id"),
        /** Source that produced avatar_file_id, as written by avatarOrigin(); the avatar is current when it equals the wanted source. */
        avatar_origin: text("avatar_origin"),
        /** Last failure of the avatar pipeline and the source it failed on; a different source makes it obsolete. */
        avatar_error: text("avatar_error"),
        avatar_error_origin: text("avatar_error_origin"),
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
    /** Language (BCP 47) AI image descriptions are written in; OCR text keeps its original language. */
    ai_language: text("ai_language").default("en-US").notNull(),
    /** Models of the roles that have no space of their own (describe, rerank); embedding roles live in library_embedding_space. */
    ai_bindings: jsonb("ai_bindings").$type<{
        describe?: { modelId: string } | null;
        rerank?: { modelId: string } | null;
    }>(),
    /** Cover Qualities: cover qualities for the library */
    cover_qualities: jsonb("cover_qualities").$type<Quality[]>().default([Quality.LOW, Quality.MEDIUM]).notNull(),
    /** Background work is on hold: the job queue claims none of the library's rows until this is cleared. */
    jobs_paused: boolean("jobs_paused").default(false).notNull(),
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
        check("post_eid_non_empty", sql`btrim(${table.eid}) <> ''`),
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
         * - Can be null for an independent media asset.
         */
        post_id: uuid("post_id"),
        library_id: uuid("library_id").notNull(),
        source: PostSourceEnum("source").notNull().default(PostSource.UNKNOWN),
        title: text("title").notNull(),
        description: text("description").notNull(),
        type: MediaTypeEnum("type").notNull(),
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
        uniqueIndex("media_post_source_eid_active_unique")
            .on(table.post_id, table.source, table.eid)
            .where(sql`${table.post_id} IS NOT NULL AND ${table.delete_status} = 'ACTIVE'`),
        uniqueIndex("media_library_source_eid_independent_active_unique")
            .on(table.library_id, table.source, table.eid)
            .where(sql`${table.post_id} IS NULL AND ${table.delete_status} = 'ACTIVE'`),
        uniqueIndex("media_post_sort_unique")
            .on(table.post_id, table.sort_order)
            .where(sql`delete_status = 'ACTIVE'`),
        index("media_source_eid_idx").on(table.source, table.eid),
        index("media_library_delete_time_idx").on(table.library_id, table.delete_time),
        index("media_post_delete_time_idx").on(table.post_id, table.delete_time),
    ],
);

export interface MediaStream {
    index: number;
    id?: string | null;
    type: TrackType.VIDEO | TrackType.AUDIO | TrackType.SUBTITLE;
    codec?: string | null;
    language?: string | null;
    label?: string | null;
    role?: string | null;
    width?: number | null;
    height?: number | null;
    bandwidth?: number | null;
    channels?: number | null;
    sample_rate?: number | null;
    is_default?: boolean;
}

export type Stream = MediaStream;

export interface TrackMetadata {
    source_file_id?: string;
    /** Generated tracks: the source file `last_error` was recorded for; a scan does not retry the same source. */
    error_source_file_id?: string;
    /** DASH / fMP4 segment index info */
    segment_base?: {
        initialization?: string;
        index_range?: string;
        timescale?: number;
        earliest_presentation_time?: string;
    };
    recipe_version?: number;
    generation_mode?: "REUSE" | "TRANSCODE" | "VIDEO_FRAME";
    seek_seconds?: number;
    generated_width?: number;
    generated_height?: number;

    frame_rate?: number;
    label?: string;
    role?: string;
    audio_group_id?: string;

    /** Low-frequency raw tags/extensions */
    raw_tags?: Record<string, string>;
    [key: string]: any;
}

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
        metadata: jsonb("metadata").$type<TrackMetadata>().default({}).notNull(),
        container: text("container"),
        is_fragmented: boolean("is_fragmented"),
        stream_layout: TrackStreamLayoutEnum("stream_layout"),
        has_video: boolean("has_video").default(false).notNull(),
        has_audio: boolean("has_audio").default(false).notNull(),
        streams: jsonb("streams").$type<MediaStream[]>().default([]).notNull(),
        variant_key: varchar("variant_key", { length: 255 }).notNull(),
        is_default: boolean("is_default").default(false).notNull(),
        is_primary: boolean("is_primary").default(false).notNull(),
        display_name: text("display_name"),
        language: text("language"),
        codec: text("codec"),
        duration: real("duration"),
        width: integer("width"),
        height: integer("height"),
        bandwidth: integer("bandwidth"),
        is_stale: boolean("is_stale").default(false).notNull(),
        source_track_id: uuid("source_track_id"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
        delete_time: temporal("delete_time"),
        delete_status: DeleteStatusEnum("delete_status").default(DeleteStatus.ACTIVE).notNull(),
    },
    (table) => [
        check("track_variant_key_non_empty", sql`btrim(${table.variant_key}) <> ''`),
        uniqueIndex("track_media_type_purpose_variant_key_active_unique")
            .on(table.media_id, table.type, table.purpose, table.variant_key)
            .where(sql`delete_status = 'ACTIVE'`),
        uniqueIndex("track_media_default_active_unique")
            .on(table.media_id, table.type, table.purpose)
            .where(sql`is_default = true AND delete_status = 'ACTIVE'`),
        uniqueIndex("track_media_primary_active_unique")
            .on(table.media_id)
            .where(sql`is_primary = true AND delete_status = 'ACTIVE'`),
    ],
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
    size: bigint("size", { mode: "number" }),
    mime_type: text("mime_type").notNull(),
    // TODO: determine nullability
    extension: text("extension"),
    path: text("path").notNull().unique(), // Path in bucket
    bucket: text("bucket").notNull(),
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

/**
 * Half-precision pgvector column without a fixed dimension, so one table can hold every
 * embedding space. halfvec halves storage and lets HNSW index up to 4000 dimensions.
 */
export const genericHalfvec = customType<{ data: number[] }>({
    dataType() {
        return "halfvec";
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
}
export const ModalityEnum = pgEnum("modality_type", [ModalityType.TEXT, ModalityType.IMAGE]);

export enum EntityType {
    POST = "POST",
    MEDIA = "MEDIA",
}
export const EntityTypeEnum = pgEnum("entity_type", [EntityType.POST, EntityType.MEDIA]);

export enum EmbeddingRole {
    AI_CAPTION = "AI_CAPTION",
    IMAGE_PRIMARY = "IMAGE_PRIMARY",
}
export const EmbeddingRoleEnum = pgEnum("embedding_role", [EmbeddingRole.AI_CAPTION, EmbeddingRole.IMAGE_PRIMARY]);

/**
 * AI Provider: a connection (endpoint + credential) owned by the same principal that owns
 * libraries. A library may only bind models from providers of its own owner; see
 * docs/ownership_and_teams.md.
 */
export const AiProvider = pgTable(
    "ai_provider",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        /** Same principal as `library.owner_id`. */
        owner_id: uuid("owner_id").notNull(),
        /** Provider template id; it fixes the wire adapter and the model catalog. */
        template_id: text("template_id").notNull(),
        name: text("name").notNull(),
        base_url: text("base_url").notNull(),
        /** API key encrypted with SECRETS_ENCRYPTION_KEY; plaintext never leaves the server. */
        api_key_ciphertext: text("api_key_ciphertext"),
        /** Simultaneous requests allowed across all server instances. */
        max_concurrency: integer("max_concurrency").default(4).notNull(),
        /** Requests per minute across all server instances; null when the provider sets no limit. */
        requests_per_minute: integer("requests_per_minute"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [index("ai_provider_owner_idx").on(table.owner_id)],
);

export const AiModelCategoryEnum = pgEnum("ai_model_category", AI_MODEL_CATEGORIES);

// AI Model table (supports custom user models and capability specifications)
export const AiModel = pgTable(
    "ai_model",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        provider_id: uuid("provider_id")
            .notNull()
            .references(() => AiProvider.id, { onDelete: "cascade" }),
        name: text("name").notNull(), // 模型实际名字，如 qwen3-vl-embedding
        /** Name shown to people, e.g. "Qwen3-VL Embedding". */
        display_name: text("display_name").notNull(),
        category: AiModelCategoryEnum("category").notNull(),
        /** Capability snapshot validated by the category's schema in features/ai/model-schema.ts. */
        capabilities: jsonb("capabilities").notNull().default({}),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [uniqueIndex("ai_model_provider_name_unique").on(table.provider_id, table.name)],
);

/**
 * Keyword search folding: NFKC (full-width and half-width forms), lowercase, ß as ss. Search
 * documents store their folded title and content; queries fold their patterns the same way.
 */
export function searchFold(value: SQLWrapper): SQL {
    return sql`replace(lower(normalize(${value}, NFKC)), 'ß', 'ss')`;
}

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
        // Stored so keyword search neither folds every row nor recomputes it to rank matches.
        folded_title: text("folded_title").generatedAlwaysAs(searchFold(sql`${sql.identifier("title")}`)),
        folded_content: text("folded_content").generatedAlwaysAs(searchFold(sql`${sql.identifier("content")}`)),
        content_hash: text("content_hash").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [
        uniqueIndex("search_doc_entity_unique").on(table.entity_type, table.entity_id),
        // Keyword search runs LIKE '%term%' on the folded columns (requires pg_trgm).
        index("search_doc_folded_title_trgm_idx").using("gin", table.folded_title.op("gin_trgm_ops")),
        index("search_doc_folded_content_trgm_idx").using("gin", table.folded_content.op("gin_trgm_ops")),
        index("search_doc_library_idx").on(table.library_id),
    ],
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
        tags: jsonb("tags").$type<string[]>().default([]).notNull(),
        objects: jsonb("objects").$type<string[]>().default([]).notNull(),
        colors: jsonb("colors").$type<string[]>().default([]).notNull(),
        styles: jsonb("styles").$type<string[]>().default([]).notNull(),
        scene: text("scene").default("").notNull(),
        ocr_text: text("ocr_text").default("").notNull(),
        /**
         * What the stored result was generated with. A row with no result yet holds what it will be
         * generated with. One row per media: a re-description keeps the old result until it is replaced.
         */
        model: text("model").notNull(),
        prompt_version: text("prompt_version").notNull(),
        language: text("language").notNull(),
        /** Hash of the source image the stored result was generated from; null until a result exists. */
        input_hash: text("input_hash"),
        /** Set by a re-description request: the stored result is regenerated even though its inputs still match. */
        is_stale: boolean("is_stale").default(false).notNull(),
        last_error: text("last_error"),
        /** Classified kind of `last_error` (see AiErrorKind in features/ai/errors.ts). */
        error_kind: text("error_kind"),
        /** Hash of the input `last_error` happened on (see describeInputHash); a changed input is tried again. */
        error_input_hash: text("error_input_hash"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [
        uniqueIndex("ai_metadata_entity_unique").on(table.entity_type, table.entity_id),
        // Serves the library coverage counts.
        index("ai_metadata_library_target_idx").on(table.library_id, table.prompt_version, table.language, table.model, table.entity_id),
    ],
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
        embedding_space_id: text("embedding_space_id").notNull(),
        embedding_role: EmbeddingRoleEnum("embedding_role").notNull(),
        input_modality: ModalityEnum("input_modality").notNull(),
        /** Null, with `embedding` and `content_hash`, while the row only records a failure. */
        dimension: integer("dimension"),
        embedding: genericHalfvec("embedding"),
        /** Hash of the stored vector's input: the source file for images, the search document for text. */
        content_hash: text("content_hash"),
        source_file_id: uuid("source_file_id"),
        last_error: text("last_error"),
        /** Classified kind of `last_error` (see AiErrorKind in features/ai/errors.ts). */
        error_kind: text("error_kind"),
        /** Hash of the input `last_error` happened on; a changed input is tried again. */
        error_input_hash: text("error_input_hash"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [
        // One row per media and space: a new input replaces the vector in place.
        uniqueIndex("asset_emb_entity_space_unique").on(table.entity_type, table.entity_id, table.embedding_space_id, table.embedding_role),
        index("asset_emb_library_space_role_idx").on(table.library_id, table.embedding_space_id, table.embedding_role),
        check("asset_emb_dimension_check", sql`vector_dims(${table.embedding}) = ${table.dimension}`),
        // HNSW needs a fixed dimension, so each supported dimension gets its own partial expression index.
        // Queries must cast with the same literal dimension and filter on it; see search.ts.
        ...EMBEDDING_DIMENSIONS.map((dimension) =>
            index(`asset_emb_hnsw_${dimension}`)
                .using("hnsw", sql`(${table.embedding}::halfvec(${sql.raw(String(dimension))})) halfvec_cosine_ops`)
                .where(sql`${table.dimension} = ${sql.raw(String(dimension))}`),
        ),
    ],
);

export enum LibraryEmbeddingSpaceStatus {
    /** Searched by the library. */
    ACTIVE = "ACTIVE",
    /** Being filled after a model change; becomes ACTIVE once it covers the library. */
    BUILDING = "BUILDING",
    /**
     * The previous ACTIVE space, kept read-only for a while after a switch so choosing its model
     * again restores it without re-embedding everything. Neither searched nor written.
     */
    RETIRED = "RETIRED",
}
export const LibraryEmbeddingSpaceStatusEnum = pgEnum("library_embedding_space_status", [
    LibraryEmbeddingSpaceStatus.ACTIVE,
    LibraryEmbeddingSpaceStatus.BUILDING,
    LibraryEmbeddingSpaceStatus.RETIRED,
]);

/**
 * Embedding spaces of a library, per embedding role. Search reads only the ACTIVE space, so
 * changing the embedding model keeps search working until the new space is complete.
 */
export const LibraryEmbeddingSpace = pgTable(
    "library_embedding_space",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        library_id: uuid("library_id").notNull(),
        /** Binding role: "textEmbedding" | "imageEmbedding". */
        role: text("role").$type<"textEmbedding" | "imageEmbedding">().notNull(),
        model_id: uuid("model_id").notNull(),
        space_id: text("space_id").notNull(),
        status: LibraryEmbeddingSpaceStatusEnum("status").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
    },
    (table) => [uniqueIndex("library_embedding_space_role_status_unique").on(table.library_id, table.role, table.status)],
);

// ==== AI & Search Tables: END ====

export enum DraftFileStatus {
    PENDING = "PENDING",
    DRAFT = "DRAFT",
    CONSUMED = "CONSUMED",
    DELETED = "DELETED",
}
export const DraftFileStatusEnum = pgEnum("draft_file_status", [
    DraftFileStatus.PENDING,
    DraftFileStatus.DRAFT,
    DraftFileStatus.CONSUMED,
    DraftFileStatus.DELETED,
]);

export const DraftFile = pgTable("draft_file", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
    file_id: uuid("file_id").notNull(),
    library_id: uuid("library_id").notNull(),
    owner_id: uuid("owner_id").notNull(),
    original_name: text("original_name").notNull(),
    status: DraftFileStatusEnum("status").default(DraftFileStatus.DRAFT).notNull(),
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time")
        .default(sql`now()`)
        .notNull(),
    expire_time: temporal("expire_time"),
    consume_time: temporal("consume_time"),
});

/**
 * Reconcile queue (docs/async_task_improvements.zh-Hans.md §11.3). A row only says "this subject may be out of
 * date for this pipeline"; the pipeline reads current state and does the difference. One row and one lease per
 * (pipeline, subject), so a subject is never reconciled twice at once.
 */
export const JobQueue = pgTable(
    "job_queue",
    {
        pipeline: text("pipeline").notNull(),
        subject_id: text("subject_id").notNull(),
        library_id: uuid("library_id").notNull(),
        priority: smallint("priority").default(0).notNull(),
        /** When the row was added. Retries and enqueues of a row already here leave it, so it shows how long work has waited. */
        enqueued_at: temporal("enqueued_at")
            .default(sql`now()`)
            .notNull(),
        available_at: temporal("available_at")
            .default(sql`now()`)
            .notNull(),
        /** Enqueued again while leased: run once more after the current run finishes. */
        dirty: boolean("dirty").default(false).notNull(),
        /** Library scans only: the last subject id paged through. */
        cursor: text("cursor"),
        lease_token: uuid("lease_token"),
        lease_expires_at: temporal("lease_expires_at"),
        attempts: integer("attempts").default(0).notNull(),
        /** Runs in a row that died without settling. A run that fails normally starts the count over. */
        interruptions: integer("interruptions").default(0).notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.pipeline, table.subject_id] }),
        index("job_queue_claim_idx").on(table.priority.desc(), table.available_at),
        index("job_queue_library_pipeline_idx").on(table.library_id, table.pipeline),
    ],
);
