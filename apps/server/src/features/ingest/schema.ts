import * as v from "valibot";

import { TrackType, TrackPurpose, TrackStreamLayout, PostSource, MediaType } from "@/db/schema";
import { Quality } from "@/lib/types";

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

export const SegmentBaseSchema = v.object({
    initialization: v.pipe(
        v.optional(v.nullable(v.string())),
        v.transform((v) => v ?? undefined),
    ),
    index_range: v.pipe(
        v.optional(v.nullable(v.string())),
        v.transform((v) => v ?? undefined),
    ),
});

export const TrackMetadataSchema = v.object({
    format: v.pipe(
        v.optional(v.nullable(v.string())),
        v.transform((v) => v ?? undefined),
    ),
    segment_base: v.pipe(
        v.optional(v.nullable(SegmentBaseSchema)),
        v.transform((v) => v ?? undefined),
    ),
});

export const TrackStreamSchema = v.object({
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

export const TrackSchema = v.object({
    url: v.pipe(v.string(), v.trim(), v.minLength(1, "url is required")),
    type: v.enum(TrackType),
    purpose: v.optional(v.enum(TrackPurpose), TrackPurpose.CONTENT),
    is_original: v.optional(v.boolean(), true),
    quality: v.optional(v.enum(Quality), Quality.HIGH),
    language: v.optional(v.nullable(v.string())),
    codec: v.optional(v.nullable(v.string())),
    duration: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
    width: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    height: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1)))),
    bandwidth: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
    metadata: v.pipe(
        v.optional(v.nullable(TrackMetadataSchema)),
        v.transform((v) => v ?? {}),
    ),
    container: v.optional(v.nullable(v.string())),
    is_fragmented: v.optional(v.nullable(v.boolean())),
    stream_layout: v.optional(v.nullable(v.enum(TrackStreamLayout))),
    has_video: v.optional(v.nullable(v.boolean())),
    has_audio: v.optional(v.nullable(v.boolean())),
    streams: v.optional(v.nullable(v.array(TrackStreamSchema))),
});

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
        tracks: v.pipe(v.array(TrackSchema), v.minLength(1, "Each media must have at least one track")),
        tags: v.optional(v.array(v.string()), []),
        duration: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
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
