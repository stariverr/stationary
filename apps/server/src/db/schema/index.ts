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
export const MediaTypeEnum = pgEnum("media_type", ["IMAGE", "VIDEO", "LIVE_PHOTO"]);
export const PostSourceEnum = pgEnum("post_source", [
    "UNKNOWN",
    "X",
    "XHS",
    "BILIBILI",
    "DOUYIN",
    "TIKTOK",
    "INSTAGRAM",
]);

export const SyncStatusEnum = pgEnum("sync_status", [
    "PENDING",
    "IN_PROGRESS",
    "COMPLETED",
    "FAILED",
]);

export const MediaFileRoleEnum = pgEnum("media_file_role", [
    "PRIMARY",
    "ALTERNATIVE",
    "COVER",
    "LIVE_PHOTO_VIDEO",
    // "THUMBNAIL",
    // "TRANSCODED",
    // "PREVIEW",
]);

export const AccessRoleEnum = pgEnum("access_role", ["VIEWER", "EDITOR", "ADMIN"]);

/** Soft delete status enum
 * - ACTIVE: Not deleted
 * - DELETED: Soft deleted, but affiliated records may still exist
 * - PURGED: Soft deleted, and all affiliated records and objects are deleted
 */
export const DeleteStatusEnum = pgEnum("delete_status", ["ACTIVE", "DELETED", "PURGED"]);

export const Author = pgTable("author", {
    id: uuid("id")
        .primaryKey()
        .notNull()
        .$defaultFn(() => uuidv7.generate()),
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
    delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
});

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
    create_time: temporal("create_time")
        .default(sql`now()`)
        .notNull(),
    update_time: temporal("update_time"),
    delete_time: temporal("delete_time"),
    delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
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
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
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
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
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
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
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
        source: PostSourceEnum("source").notNull().default("UNKNOWN"),
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
        sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
        last_error: text("last_error"),
        workflow_run_id: text("workflow_run_id"),
        library_id: uuid("library_id").notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
        delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
        delete_time: temporal("delete_time"),
        recycle_time: temporal("recycle_time"),
    },
    (table) => [
        uniqueIndex("post_source_eid_unique").on(table.source, table.eid),
        index("post_library_delete_time_idx").on(table.library_id, table.delete_time),
    ],
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
        source: PostSourceEnum("source").notNull().default("UNKNOWN"),
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
        sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
        last_error: text("last_error"),
        workflow_run_id: text("workflow_run_id"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time"),
        delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
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

// MediaFile Model
export const MediaFile = pgTable(
    "media_file",
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
        role: MediaFileRoleEnum("role").notNull(),
        /** Sort Order of Media Variant (Not media.sort_order, which is sort order of media in the post) */
        sort_order: integer("sort_order").default(0).notNull(),
        source_url: text("source_url").default(""),
        sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
        last_error: text("last_error"),
        metadata: jsonb("metadata").default({}).notNull(),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
        delete_time: temporal("delete_time"),
        delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
    },
    (table) => [
        uniqueIndex("media_file_media_role_sort_unique").on(
            table.media_id,
            table.role,
            table.sort_order,
        ),
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
    delete_status: DeleteStatusEnum("delete_status").default("ACTIVE").notNull(),
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
