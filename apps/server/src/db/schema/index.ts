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
        /**
         * Size as displayed (rotation applied) and length, probed from the originals (docs/media_refactor.zh-Hans.md,
         * 3.2): IMAGE and LIVE_PHOTO take the size from the image original, VIDEO from its video stream; durations come
         * from the longest audio or video original. Null where the type has none, or until the originals are probed.
         */
        display_width: integer("display_width"),
        display_height: integer("display_height"),
        duration: real("duration"),
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
        check("media_display_size_pair", sql`(${table.display_width} IS NULL) = (${table.display_height} IS NULL)`),
        check("media_display_size_by_type", sql`${table.type} NOT IN ('AUDIO', 'PDF') OR ${table.display_width} IS NULL`),
        check("media_duration_by_type", sql`${table.type} NOT IN ('IMAGE', 'PDF') OR ${table.duration} IS NULL`),
        index("media_library_delete_time_idx").on(table.library_id, table.delete_time),
        index("media_post_delete_time_idx").on(table.post_id, table.delete_time),
    ],
);

/**
 * The original cover of a media (docs/media_refactor.zh-Hans.md, 3.4): a user upload, or a platform cover that the
 * download pipeline fetches from `source_url`. At most one per media, and only VIDEO, AUDIO and PDF media have one.
 * - [Hard Delete] The row goes when the cover is removed or replaced; its file is soft deleted.
 */
export const MediaCover = pgTable(
    "media_cover",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        file_id: uuid("file_id"),
        /** Where an imported cover is downloaded from; null for a user upload. */
        source_url: text("source_url"),
        /** The import's stable key for the cover; a sync with the same key keeps the cover even if the URL changed. */
        source_key: text("source_key"),
        status: SyncStatusEnum("status").notNull(),
        last_error: text("last_error"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [
        uniqueIndex("media_cover_media_unique").on(table.media_id),
        check("media_cover_file_when_completed", sql`(${table.status} = 'COMPLETED') = (${table.file_id} IS NOT NULL)`),
        check("media_cover_source_or_file", sql`${table.source_url} IS NOT NULL OR ${table.file_id} IS NOT NULL`),
        check("media_cover_source_pair", sql`(${table.source_url} IS NULL) = (${table.source_key} IS NULL)`),
    ],
);

export enum PreviewSize {
    SMALL = "SMALL",
    MEDIUM = "MEDIUM",
    LARGE = "LARGE",
}
export const PreviewSizeEnum = pgEnum("preview_size", [PreviewSize.SMALL, PreviewSize.MEDIUM, PreviewSize.LARGE]);

/**
 * A preview image the `preview` pipeline renders for a media (docs/media_refactor.zh-Hans.md, 3.5). A row is either
 * a result (file and size) or the final failure (`last_error`), both for `source_file_id` at `recipe_version`. It is
 * current while those match the media's current preview source and the current recipe.
 * - [Hard Delete] Replaced in place; a superseded file is soft deleted.
 */
export const MediaPreview = pgTable(
    "media_preview",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        size: PreviewSizeEnum("size").notNull(),
        /** The cover or content file the preview was rendered from (or failed on). */
        source_file_id: uuid("source_file_id").notNull(),
        recipe_version: integer("recipe_version").notNull(),
        file_id: uuid("file_id"),
        width: integer("width"),
        height: integer("height"),
        last_error: text("last_error"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [
        uniqueIndex("media_preview_media_size_unique").on(table.media_id, table.size),
        check("media_preview_result_or_failure", sql`(${table.file_id} IS NOT NULL) <> (${table.last_error} IS NOT NULL)`),
        check(
            "media_preview_size_with_file",
            sql`(${table.file_id} IS NULL) = (${table.width} IS NULL) AND (${table.file_id} IS NULL) = (${table.height} IS NULL)`,
        ),
    ],
);

/**
 * An original file of a media (docs/media_refactor.zh-Hans.md, 3.3): what the user uploaded or the import fetched,
 * never modified. What it holds (an image, a video, audio only) is read from its probed content, not stored here.
 * Replacing an original deletes its row and inserts a new one, so a probe result never goes stale.
 * - [Hard Delete] With it go its `av_file` and `av_stream` rows and what was extracted from it; files are soft deleted.
 */
export const MediaOriginal = pgTable(
    "media_original",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        /** Set once downloaded and probed; a user upload is probed before it is inserted. */
        file_id: uuid("file_id"),
        /** Where an imported original is downloaded from, and its stable key in the import; both null for an upload. */
        source_url: text("source_url"),
        source_key: text("source_key"),
        /** Import declarations for the audio streams inside, applied over the probe (3.7). */
        declared_language: text("declared_language"),
        declared_label: text("declared_label"),
        declared_default: boolean("declared_default"),
        /** COMPLETED means downloaded and probed; a source or probe that is rejected ends FAILED. */
        status: SyncStatusEnum("status").notNull(),
        last_error: text("last_error"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [
        index("media_original_media_idx").on(table.media_id),
        uniqueIndex("media_original_media_source_key_unique").on(table.media_id, table.source_key).where(sql`${table.source_key} IS NOT NULL`),
        check("media_original_file_when_completed", sql`(${table.status} = 'COMPLETED') = (${table.file_id} IS NOT NULL)`),
        check("media_original_source_pair", sql`(${table.source_url} IS NULL) = (${table.source_key} IS NULL)`),
        check("media_original_source_or_file", sql`${table.source_url} IS NOT NULL OR ${table.file_id} IS NOT NULL`),
    ],
);

/**
 * The container facts of an audio or video file (3.6), read only by the playback assembly. The segment columns come
 * from the sidx of an fMP4 and are all set or all null; HLS and DASH only reference files that have them.
 * - [Hard Delete] Goes with the original it describes.
 */
export const AvFile = pgTable(
    "av_file",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        file_id: uuid("file_id").notNull(),
        /** ffprobe's format name, e.g. `mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`. */
        container: text("container").notNull(),
        duration: real("duration"),
        bitrate: integer("bitrate"),
        /** The init segment is bytes [0, init_size). */
        init_size: integer("init_size"),
        /** The sidx box is bytes [index_offset, index_offset + index_size). */
        index_offset: bigint("index_offset", { mode: "number" }),
        index_size: integer("index_size"),
        timescale: integer("timescale"),
        earliest_presentation_time: bigint("earliest_presentation_time", { mode: "number" }),
    },
    (table) => [
        uniqueIndex("av_file_file_unique").on(table.file_id),
        check(
            "av_file_segment_all_or_none",
            sql`(${table.init_size} IS NULL) = (${table.index_offset} IS NULL)
                AND (${table.init_size} IS NULL) = (${table.index_size} IS NULL)
                AND (${table.init_size} IS NULL) = (${table.timescale} IS NULL)
                AND (${table.init_size} IS NULL) = (${table.earliest_presentation_time} IS NULL)`,
        ),
    ],
);

export enum AvStreamType {
    VIDEO = "VIDEO",
    AUDIO = "AUDIO",
    SUBTITLE = "SUBTITLE",
}
export const AvStreamTypeEnum = pgEnum("av_stream_type", [AvStreamType.VIDEO, AvStreamType.AUDIO, AvStreamType.SUBTITLE]);

/**
 * One stream of an audio or video file (3.7). Attached pictures (album art) are not streams here.
 * `codec_string` is the RFC 6381 string read from the MP4 sample entry, so only video and audio streams in MP4 files
 * have one; every stream a manifest lists is in a single-stream fMP4 and has it.
 * `language`, `label` and `is_default` come from the probe, then the import's declaration, then the user.
 * - [Hard Delete] Goes with its `av_file`.
 */
export const AvStream = pgTable(
    "av_stream",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        av_file_id: uuid("av_file_id").notNull(),
        stream_index: integer("stream_index").notNull(),
        type: AvStreamTypeEnum("type").notNull(),
        /** ffprobe's `codec_name`, stored as is (`h264`, `hevc`, `aac`, `opus`, `subrip`...). */
        codec: text("codec").notNull(),
        codec_string: text("codec_string"),
        bitrate: integer("bitrate"),
        language: text("language"),
        label: text("label"),
        is_default: boolean("is_default").default(false).notNull(),
        /** Coded size; the displayed size applies `rotation`. */
        width: integer("width"),
        height: integer("height"),
        rotation: smallint("rotation"),
        frame_rate: real("frame_rate"),
        channels: smallint("channels"),
        sample_rate: integer("sample_rate"),
    },
    (table) => [
        uniqueIndex("av_stream_file_index_unique").on(table.av_file_id, table.stream_index),
        check("av_stream_video_size", sql`(${table.type} = 'VIDEO') = (${table.width} IS NOT NULL AND ${table.height} IS NOT NULL)`),
        check("av_stream_video_only_fields", sql`${table.type} = 'VIDEO' OR (${table.rotation} IS NULL AND ${table.frame_rate} IS NULL)`),
        check("av_stream_rotation_values", sql`${table.rotation} IS NULL OR ${table.rotation} IN (0, 90, 180, 270)`),
        check("av_stream_audio_channels", sql`(${table.type} = 'AUDIO') = (${table.channels} IS NOT NULL)`),
        check("av_stream_audio_only_fields", sql`${table.type} = 'AUDIO' OR ${table.sample_rate} IS NULL`),
        check("av_stream_subtitle_no_codec_string", sql`${table.type} <> 'SUBTITLE' OR ${table.codec_string} IS NULL`),
    ],
);

export enum AssetOrigin {
    FILE = "FILE",
    EMBEDDED = "EMBEDDED",
}
export const AssetOriginEnum = pgEnum("asset_origin", [AssetOrigin.FILE, AssetOrigin.EMBEDDED]);

/**
 * A caption of an audio or video media (3.8), served as WebVTT. FILE captions keep the uploaded or imported file
 * (SRT, ASS, VTT) in `source_file_id` and its conversion in `vtt_file_id`; EMBEDDED captions are text streams
 * extracted from an original and point at that stream.
 * - [Hard Delete] Files are soft deleted; EMBEDDED ones go with their original.
 */
export const MediaCaption = pgTable(
    "media_caption",
    {
        id: uuid("id")
            .primaryKey()
            .notNull()
            .$defaultFn(() => uuidv7.generate()),
        media_id: uuid("media_id").notNull(),
        origin: AssetOriginEnum("origin").notNull(),
        language: text("language"),
        label: text("label"),
        is_default: boolean("is_default").default(false).notNull(),
        vtt_file_id: uuid("vtt_file_id"),
        source_file_id: uuid("source_file_id"),
        source_stream_id: uuid("source_stream_id"),
        source_url: text("source_url"),
        source_key: text("source_key"),
        status: SyncStatusEnum("status").notNull(),
        last_error: text("last_error"),
        create_time: temporal("create_time")
            .default(sql`now()`)
            .notNull(),
        update_time: temporal("update_time")
            .default(sql`now()`)
            .notNull(),
    },
    (table) => [
        index("media_caption_media_idx").on(table.media_id),
        uniqueIndex("media_caption_media_default_unique").on(table.media_id).where(sql`${table.is_default}`),
        uniqueIndex("media_caption_media_source_key_unique").on(table.media_id, table.source_key).where(sql`${table.source_key} IS NOT NULL`),
        check("media_caption_embedded_stream", sql`(${table.origin} = 'EMBEDDED') = (${table.source_stream_id} IS NOT NULL)`),
        check("media_caption_file_source_only", sql`${table.origin} = 'FILE' OR ${table.source_file_id} IS NULL`),
        check("media_caption_vtt_when_completed", sql`(${table.status} = 'COMPLETED') = (${table.vtt_file_id} IS NOT NULL)`),
        check(
            "media_caption_file_source_when_completed",
            sql`${table.origin} = 'EMBEDDED' OR ${table.status} <> 'COMPLETED' OR ${table.source_file_id} IS NOT NULL`,
        ),
        check("media_caption_source_pair", sql`(${table.source_url} IS NULL) = (${table.source_key} IS NULL)`),
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
 * Reconcile queue (docs/job_queue.zh-Hans.md, section 4). A row only says "this subject may be out of
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
        /**
         * Claims since the input last changed, so whether the subject is still worth trying. Counted at claim, so a run
         * that dies counts too; a postponed run gives its claim back. A run that fails with this at the limit gives up.
         */
        attempts: integer("attempts").default(0).notNull(),
        /**
         * Runs in a row that died without settling (crashed, killed or stuck until the lease expired), so whether running
         * the subject takes the worker down. A run that fails normally starts the count over; at the limit the subject
         * is given up before it runs. Kept apart from attempts so one crash after ordinary failures is not taken for a
         * poison pill.
         */
        interruptions: integer("interruptions").default(0).notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.pipeline, table.subject_id] }),
        index("job_queue_claim_idx").on(table.priority.desc(), table.available_at),
        index("job_queue_library_pipeline_idx").on(table.library_id, table.pipeline),
    ],
);
