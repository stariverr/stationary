import * as v from "valibot";
import { PostSource, MediaType } from "@/db/schema";

export const MediaListRequestBodySchema = v.object({
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
    media_type: v.optional(v.enum(MediaType)),
    tag_ids: v.optional(v.string()),
    author_ids: v.optional(v.string()),
});

export const SingleRegenerateCoverParamSchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
});

export const BatchRegenerateCoversSchema = v.pipe(
    v.object({
        media_ids: v.optional(v.array(v.pipe(v.string(), v.uuid()))),
        library_id: v.optional(v.pipe(v.string(), v.uuid())),
    }),
    v.check((data) => {
        const hasMediaIds = Boolean(data.media_ids && data.media_ids.length > 0);
        const hasLibraryId = Boolean(data.library_id);
        return (hasMediaIds && !hasLibraryId) || (!hasMediaIds && hasLibraryId);
    }, "Must provide either 'media_ids' array or 'library_id', but not both."),
);

export const GetMpdRequestSchema = v.object({
    session_token: v.optional(v.string()),
});

export const GetHlsRequestSchema = v.object({
    session_token: v.optional(v.string()),
});

export const GetHlsVariantRequestSchema = v.object({
    session_token: v.optional(v.string()),
});

export const MediaUpdateInfoSchema = v.pipe(
    v.object({
        title: v.optional(v.string()),
        description: v.optional(v.string()),
        published_time: v.optional(v.nullable(v.string())),
    }),
    v.check((data) => Object.keys(data).length > 0, "At least one field must be provided for update"),
);

export const MediaReplaceTagsSchema = v.object({
    tags: v.array(v.string()),
});
