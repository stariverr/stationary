import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { AssetAiMetadata, DeleteStatus, EntityType, Media, MediaTag, Post, PostTag, Tag, TagStatus } from "@/db/schema";
import { db } from "@/global/db";
import { computeSha256 } from "./utils";

/** Searchable text of a media item: one non-empty field per line, duplicates dropped. */
export function buildSearchContent(fields: Array<string | null | undefined>): string {
    return [...new Set(fields.map((field) => field?.trim() ?? "").filter(Boolean))].join("\n");
}

export interface SearchDocumentContent {
    library_id: string;
    source: string;
    media_type: string;
    title: string;
    content: string;
}

/**
 * The search document an active media should have now: its own and its post's title, description and tags, the
 * aliases of those tags, and its stored AI description (of its current library only). Null for media that are
 * deleted or in the recycle bin.
 */
export async function buildSearchDocument(mediaId: string): Promise<{ document: SearchDocumentContent; contentHash: string } | null> {
    const [media] = await db
        .select()
        .from(Media)
        .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
        .limit(1);
    if (!media) return null;

    const [post] = media.post_id
        ? await db
              .select({ id: Post.id, source: Post.source, title: Post.title, description: Post.description })
              .from(Post)
              .where(and(eq(Post.id, media.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)))
              .limit(1)
        : [];

    const tagColumns = { id: Tag.id, name: Tag.name, canonical_tag_id: Tag.canonical_tag_id };
    const [postTags, mediaTags, [description]] = await Promise.all([
        post
            ? db
                  .select(tagColumns)
                  .from(PostTag)
                  .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                  .where(and(eq(PostTag.post_id, post.id), eq(Tag.status, TagStatus.ACTIVE)))
            : [],
        db
            .select(tagColumns)
            .from(MediaTag)
            .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
            .where(and(eq(MediaTag.media_id, media.id), eq(Tag.status, TagStatus.ACTIVE))),
        db
            .select({
                library_id: AssetAiMetadata.library_id,
                input_hash: AssetAiMetadata.input_hash,
                scene: AssetAiMetadata.scene,
                caption: AssetAiMetadata.caption,
                ocr_text: AssetAiMetadata.ocr_text,
            })
            .from(AssetAiMetadata)
            .where(and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), eq(AssetAiMetadata.entity_id, media.id)))
            .limit(1),
    ]);

    // Both direct and canonical tag aliases affect search content.
    const canonicalTagIds = [...new Set([...postTags, ...mediaTags].map((tag) => tag.canonical_tag_id || tag.id))];
    const groupTags =
        canonicalTagIds.length > 0
            ? await db
                  .select({ name: Tag.name })
                  .from(Tag)
                  .where(
                      and(
                          eq(Tag.status, TagStatus.ACTIVE),
                          or(inArray(Tag.id, canonicalTagIds), inArray(Tag.canonical_tag_id, canonicalTagIds)),
                      ),
                  )
            : [];
    const directTags = new Set([...postTags, ...mediaTags].map((tag) => tag.name));
    const tagAliases = [...new Set(groupTags.map((tag) => tag.name))].filter((name) => !directTags.has(name));

    // A description of another library belongs to the media's previous library and is about to be replaced.
    const stored = description?.input_hash && description.library_id === media.library_id ? description : null;

    // Plain values only: field labels would make every document match words like "title" or "tags".
    const content = buildSearchContent([
        media.title,
        media.description,
        post?.title,
        post?.description,
        postTags.map((tag) => tag.name).join(", "),
        mediaTags.map((tag) => tag.name).join(", "),
        tagAliases.join(", "),
        stored?.scene,
        stored?.caption,
        stored?.ocr_text,
    ]);
    const document: SearchDocumentContent = {
        library_id: media.library_id,
        source: post?.source ?? media.source,
        media_type: media.type,
        title: media.title || post?.title || "",
        content,
    };
    return { document, contentHash: await computeSha256(JSON.stringify(document)) };
}
