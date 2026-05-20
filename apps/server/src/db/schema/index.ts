import {
    pgTable,
    serial,
    text,
    timestamp,
    pgEnum,
    integer,
    jsonb,
    uuid,
    boolean,
    uniqueIndex,
    index,
} from "drizzle-orm/pg-core";
import { v7 as createUuidV7 } from "uuid";

const uuidv7 = { generate: createUuidV7 };

// Enums
export const MediaTypeEnum = pgEnum("media_type", [
    "IMAGE",
    "VIDEO",
    "LIVE_PHOTO",
]);
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

export const AccessRoleEnum = pgEnum("access_role", [
    "VIEWER",
    "EDITOR",
    "ADMIN",
]);

export const Author = pgTable("author", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    eid: text("eid").notNull().default(""),
    short_eid: text("short_eid").notNull().default(""),
    nickname: text("nickname").notNull().default(""),
    signature: text("signature").notNull().default(""),
    platform: PostSourceEnum("platform").notNull(),
    avatar_file_id: uuid("avatar_file_id"),
    /** Avatar Thumb Path */
    avatar_thumb_file_id: uuid("avatar_thumb_file_id"),
});

export const Library = pgTable("library", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    description: text("description").notNull(),
    cover_file_id: uuid("cover_file_id"),
    /** 所属用户 */
    owner_id: uuid("owner_id"),
    /** 是否公开 */
    is_public: boolean("is_public").default(false).notNull(),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
})

export const UserGroup = pgTable("user_group", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    description: text("description"),
    owner_id: uuid("owner_id").notNull(),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
});

export const UserGroupMember = pgTable("user_group_member", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    group_id: uuid("group_id").notNull(),
    user_id: uuid("user_id").notNull(),
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
    create_time: timestamp("create_time").defaultNow().notNull(),
});

export const LibraryUserAccess = pgTable("library_user_access", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    library_id: uuid("library_id"),
    user_id: uuid("user_id"),
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
})

export const LibraryGroupAccess = pgTable("library_group_access", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    library_id: uuid("library_id"),
    group_id: uuid("group_id"),
    role: AccessRoleEnum("role").notNull().default("VIEWER"),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
})

// Post Model
export const Post = pgTable("post", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    source: PostSourceEnum("source").notNull().default("UNKNOWN"),
    eid: text("eid").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    tags: jsonb("tags").$type<string[]>().default([]).notNull(),
    author_name: text("author_name").default("").notNull(),
    author_external_id: text("author_external_id"),
    author_id: uuid("author_id"),
    create_time: timestamp("create_time", { mode: "string" }).defaultNow().notNull(),
    /** Original published time on the source platform */
    published_time: timestamp("published_time", { mode: "string" }),
    media_count: integer("media_count").notNull(),
    url: text("url"),
    sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
    last_error: text("last_error"),
    workflow_run_id: text("workflow_run_id"),
    library_id: uuid("library_id").notNull(),
});



// Media Model
export const Media = pgTable("media", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    sort_order: integer("sort_order").notNull(),
    eid: text("eid").notNull(),
    post_id: uuid("post_id"),
    library_id: uuid("library_id").notNull(),
    source: PostSourceEnum("source").notNull().default("UNKNOWN"),
    title: text("title").notNull(),
    description: text("description").notNull(),
    type: MediaTypeEnum("type").notNull(),
    /** Media Original URL */
    primary_url: text("primary_url"),
    /** Alternative Media Original URL */
    alternative_url: text("alternative_url"),
    /** Live Photo Original URL */
    live_photo_url: text("live_photo_url"),
    /** Video Cover URL */
    cover_url: text("cover_url"),
    create_time: timestamp("create_time", { mode: "string" }).defaultNow().notNull(),
    /** Original published time on the source platform */
    published_time: timestamp("published_time", { mode: "string" }),
    sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
    last_error: text("last_error"),
    workflow_run_id: text("workflow_run_id"),
    update_time: timestamp("update_time").defaultNow().notNull(),
}, (table) => [
    uniqueIndex("media_post_sort_unique").on(table.post_id, table.sort_order),
    index("media_source_eid_idx").on(table.source, table.eid),
]);

// MediaFile Model
export const MediaFile = pgTable("media_file", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    media_id: uuid("media_id").notNull(),
    file_id: uuid("file_id"),
    role: MediaFileRoleEnum("role").notNull(),
    sort_order: integer("sort_order").default(0).notNull(),
    source_url: text("source_url"),
    sync_status: SyncStatusEnum("sync_status").default("PENDING").notNull(),
    last_error: text("last_error"),
    metadata: jsonb("metadata").default({}).notNull(),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
});

// Better Auth Tables
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

// Business User Table
export const User = pgTable("user", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    auth_id: text("auth_id").notNull(), // .references(() => BetterUser.id, { onDelete: 'cascade' }),
    name: text("name").notNull(),
    image: text("image"),
    create_time: timestamp("create_time").defaultNow().notNull(),
    update_time: timestamp("update_time").defaultNow().notNull(),
});

// Files (The physical assets in S3)
export const File = pgTable("file", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    hash: text("hash"), // SHA-256 for deduplication
    size: integer("size"),
    mime_type: text("mime_type"),
    extension: text("extension"),
    s3_key: text("s3_key").notNull().unique(), // Path in bucket
    s3_bucket: text("s3_bucket").notNull().default("stationary"),
    width: integer("width"),  // Metadata for quick rendering
    height: integer("height"),
    duration: integer("duration"), // For videos
    create_time: timestamp("create_time").defaultNow().notNull(),
});

// External API Token (M2M)
export const ExternalApiToken = pgTable("external_api_token", {
    id: uuid("id").primaryKey().notNull().$defaultFn(() => uuidv7.generate()),
    name: text("name").notNull(),
    token_hash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull().default("st"),
    first_four: text("first_four").notNull().default(""),
    last_four: text("last_four").notNull().default(""),
    owner_id: uuid("owner_id").notNull(), // User.id (UUID)
    library_id: uuid("library_id"), // Optional scope limit to a single Library (UUID)
    last_used_at: timestamp("last_used_at"),
    expires_at: timestamp("expires_at"),
    revoked_at: timestamp("revoked_at"),
    create_time: timestamp("create_time").defaultNow().notNull(),
});

