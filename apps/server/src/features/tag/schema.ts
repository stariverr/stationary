import * as v from "valibot";
import { TagStatus } from "@/db/schema";

export const TagListQuerySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    status: v.optional(v.enum(TagStatus)),
});

export const TagCreateBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    name: v.pipe(v.string(), v.nonEmpty()),
    color: v.optional(v.string()),
});

export const TagUpdateBodySchema = v.object({
    id: v.pipe(v.string(), v.uuid()),
    name: v.optional(v.pipe(v.string(), v.nonEmpty())),
    color: v.optional(v.nullable(v.string())),
    status: v.optional(v.enum(TagStatus)),
});

export const TagMergeBodySchema = v.object({
    library_id: v.pipe(v.string(), v.uuid()),
    source_tag_id: v.pipe(v.string(), v.uuid()),
    target_tag_id: v.pipe(v.string(), v.uuid()),
    retain_as_alias: v.optional(v.boolean(), true),
});

export type TagListQuery = v.InferOutput<typeof TagListQuerySchema>;
export type TagCreateInput = v.InferOutput<typeof TagCreateBodySchema>;
export type TagUpdateInput = v.InferOutput<typeof TagUpdateBodySchema>;
export type TagMergeInput = v.InferOutput<typeof TagMergeBodySchema>;
