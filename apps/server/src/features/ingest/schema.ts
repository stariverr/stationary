import * as v from "valibot";

import { PostSource, MediaType } from "@/db/schema";

export const AuthorSchema = v.object({
    name: v.optional(v.string(), ""),
    short_id: v.optional(v.string()),
    external_id: v.optional(v.string()),
    avatar_file_url: v.optional(v.nullable(v.string())),
    signature: v.optional(v.nullable(v.string())),
});

export const TimestampSchema = v.pipe(
    v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === null || val === "" ? undefined : val)),
            v.optional(v.string()),
        ),
    ),
    v.transform((val) => {
        if (val === undefined) return undefined;
        if (typeof val === "string" && /^\d+$/.test(val)) {
            const num = Number.parseInt(val, 10);
            if (val.length === 10) return Temporal.Instant.fromEpochMilliseconds(num * 1000);
            if (val.length === 13) return Temporal.Instant.fromEpochMilliseconds(num);
            return Temporal.Instant.fromEpochMilliseconds(num);
        }
        return Temporal.Instant.from(val as string);
    }),
);

const SourceUrlSchema = v.pipe(v.string(), v.trim(), v.minLength(1, "url is required"));
/** Names a source within its media, stable across syncs (e.g. `video`, `audio:ja`, `caption:zh-CN`). */
const SourceKeySchema = v.pipe(v.string(), v.trim(), v.minLength(1, "source_key is required"), v.maxLength(200));
const DeclaredTextSchema = v.pipe(
    v.optional(v.nullable(v.pipe(v.string(), v.trim()))),
    v.transform((value) => value || null),
);

/** A file of the media as published: its video, separate audio or image. Its streams are probed after download. */
export const ImportOriginalSchema = v.object({
    url: SourceUrlSchema,
    source_key: SourceKeySchema,
    language: DeclaredTextSchema,
    label: DeclaredTextSchema,
    is_default: v.optional(v.boolean(), false),
});

export const ImportCoverSchema = v.object({
    url: SourceUrlSchema,
    source_key: SourceKeySchema,
});

export const ImportCaptionSchema = v.object({
    url: SourceUrlSchema,
    source_key: SourceKeySchema,
    language: DeclaredTextSchema,
    label: DeclaredTextSchema,
    is_default: v.optional(v.boolean(), false),
});

const uniqueKeys = <T extends { source_key: string }>(message: string) =>
    v.check<T[], string>((items) => new Set(items.map((item) => item.source_key)).size === items.length, message);

export const MediaItemSchema = v.pipe(
    v.object({
        external_id: v.pipe(v.string(), v.trim(), v.minLength(1, "external_id is required")),
        title: v.pipe(
            v.optional(v.nullable(v.string())),
            v.transform((v) => v ?? ""),
        ),
        description: v.pipe(
            v.optional(v.nullable(v.string())),
            v.transform((v) => v ?? ""),
        ),
        type: v.enum(MediaType),
        originals: v.pipe(
            v.array(ImportOriginalSchema),
            v.minLength(1, "Each media must have at least one original"),
            uniqueKeys("Original source_key must be unique within a media"),
        ),
        cover: v.optional(v.nullable(ImportCoverSchema), null),
        captions: v.pipe(
            v.optional(v.array(ImportCaptionSchema), []),
            uniqueKeys("Caption source_key must be unique within a media"),
            v.check((captions) => captions.filter((caption) => caption.is_default).length <= 1, "Only one caption can be the default"),
        ),
        tags: v.optional(v.array(v.string()), []),
        create_time: v.optional(TimestampSchema),
        published_time: v.optional(TimestampSchema),
    }),
    v.transform((data) => ({
        ...data,
        published_time: data.published_time ?? data.create_time,
    })),
);

export const PostItemSchema = v.pipe(
    v.object({
        title: v.string(),
        url: v.optional(v.string()),
        description: v.optional(v.string(), ""),
        external_id: v.pipe(v.string(), v.trim(), v.minLength(1, "external_id is required")),
        tags: v.optional(v.array(v.string()), []),
        author: AuthorSchema,
        platform: v.enum(PostSource),
        media: v.array(MediaItemSchema),
        create_time: v.optional(TimestampSchema),
        published_time: v.optional(TimestampSchema),
    }),
    v.transform((data) => ({
        ...data,
        published_time: data.published_time ?? data.create_time,
    })),
);

export const CreateTaskSchema = v.pipe(
    v.object({
        library_id: v.pipe(v.string(), v.uuid()),
        posts: v.array(PostItemSchema),
    }),
    v.check(
        (data) =>
            data.posts.every((post) => {
                const ids = post.media.map((media) => media.external_id);
                return new Set(ids).size === ids.length;
            }),
        "Media external_id must be unique within each post",
    ),
);

export const WorkflowPayloadSchema = v.object({
    posts: v.array(
        v.object({
            data: PostItemSchema,
            id: v.string(),
            authorId: v.nullable(v.string()),
        }),
    ),
});

export type AuthorData = v.InferOutput<typeof AuthorSchema>;
export type MediaItemData = v.InferOutput<typeof MediaItemSchema>;
export type PostItemData = v.InferOutput<typeof PostItemSchema>;
export type CreateTaskPayload = v.InferOutput<typeof CreateTaskSchema>;
export type WorkflowPayload = v.InferOutput<typeof WorkflowPayloadSchema>;
