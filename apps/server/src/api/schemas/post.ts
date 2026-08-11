import * as v from "valibot";
import { PostSource, MediaType } from "@/db/schema";

export const PostListRequestBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    page: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(v.pipe(v.number(), v.integer(), v.minValue(1, "Page must be 1 or greater."))),
        ),
    ),
    count: v.optional(
        v.pipe(
            v.unknown(),
            v.transform((val) => (val === "" || val === undefined ? undefined : Number(val))),
            v.optional(
                v.pipe(
                    v.number(),
                    v.integer(),
                    v.minValue(10, "Count must be 10 or greater."),
                    v.maxValue(100, "Count must be 100 or less."),
                ),
            ),
        ),
    ),
    keyword: v.optional(v.string()),
    source: v.optional(v.enum(PostSource)),
    sort_by: v.optional(v.picklist(["import_time", "published_time"])),
    sort_order: v.optional(v.picklist(["asc", "desc"])),
    author_ids: v.optional(v.string()),
    media_type: v.optional(v.enum(MediaType)),
    tag_ids: v.optional(v.string()),
});

export const PostAuthorsQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
});

export const PostDetailRequestPathParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
});

export const PostMediaListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
});

export const PostMediaListParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
});

export const PostUpdateInfoSchema = v.pipe(
    v.object({
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        author_name: v.optional(v.string()),
        author_external_id: v.optional(v.nullable(v.string())),
        author_avatar_file_id: v.optional(v.nullable(v.pipe(v.string(), v.uuid()))),
        published_time: v.optional(v.nullable(v.string())),
        url: v.optional(v.nullable(v.string())),
    }),
    v.check((data) => Object.keys(data).length > 0, "At least one field must be provided for update"),
);

export const PostReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});

export const PostAttachMediaSchema = v.object({
    media_ids: v.array(v.pipe(v.string(), v.uuid())),
});

export const PostReorderMediaSchema = v.object({
    media_orders: v.array(
        v.object({
            media_id: v.pipe(v.string(), v.uuid()),
            sort_order: v.pipe(v.number(), v.integer(), v.minValue(0)),
        }),
    ),
});
