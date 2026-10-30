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

/** Pushes `value` onto the list at `key`, starting the list when needed. */
function addTo<V>(lists: Map<string, V[]>, key: string, value: V): void {
    const list = lists.get(key);
    if (list) list.push(value);
    else lists.set(key, [value]);
}

export interface BuiltSearchDocument {
    document: SearchDocumentContent;
    contentHash: string;
}

/**
 * The search documents the given media should have now: their own and their post's title, description and tags, the
 * aliases of those tags, and their stored AI description (of their current library only). Media that are deleted or in
 * the recycle bin are left out.
 */
export async function buildSearchDocuments(mediaIds: readonly string[]): Promise<Map<string, BuiltSearchDocument>> {
    const media = await db
        .select()
        .from(Media)
        .where(and(inArray(Media.id, [...mediaIds]), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
    const ids = media.map((row) => row.id);
    const postIds = [...new Set(media.flatMap((row) => (row.post_id ? [row.post_id] : [])))];

    const tagColumns = { id: Tag.id, name: Tag.name, canonical_tag_id: Tag.canonical_tag_id };
    const [posts, postTags, mediaTags, descriptions] = await Promise.all([
        db
            .select({ id: Post.id, source: Post.source, title: Post.title, description: Post.description })
            .from(Post)
            .where(and(inArray(Post.id, postIds), eq(Post.delete_status, DeleteStatus.ACTIVE))),
        db
            .select({ ...tagColumns, owner: PostTag.post_id })
            .from(PostTag)
            .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
            .where(and(inArray(PostTag.post_id, postIds), eq(Tag.status, TagStatus.ACTIVE))),
        db
            .select({ ...tagColumns, owner: MediaTag.media_id })
            .from(MediaTag)
            .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
            .where(and(inArray(MediaTag.media_id, ids), eq(Tag.status, TagStatus.ACTIVE))),
        db
            .select({
                id: AssetAiMetadata.entity_id,
                library_id: AssetAiMetadata.library_id,
                input_hash: AssetAiMetadata.input_hash,
                scene: AssetAiMetadata.scene,
                caption: AssetAiMetadata.caption,
                ocr_text: AssetAiMetadata.ocr_text,
            })
            .from(AssetAiMetadata)
            .where(and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), inArray(AssetAiMetadata.entity_id, ids))),
    ]);

    // Both direct and canonical tag aliases affect search content.
    const canonicalId = (tag: { id: string; canonical_tag_id: string | null }) => tag.canonical_tag_id || tag.id;
    const canonicalTagIds = [...new Set([...postTags, ...mediaTags].map(canonicalId))];
    const groupTags = await db
        .select({ id: Tag.id, name: Tag.name, canonical_tag_id: Tag.canonical_tag_id })
        .from(Tag)
        .where(and(eq(Tag.status, TagStatus.ACTIVE), or(inArray(Tag.id, canonicalTagIds), inArray(Tag.canonical_tag_id, canonicalTagIds))));

    const postById = new Map(posts.map((post) => [post.id, post]));
    const descriptionById = new Map(descriptions.map((description) => [description.id, description]));
    const tagsByOwner = new Map<string, typeof postTags>();
    for (const tag of [...postTags, ...mediaTags]) addTo(tagsByOwner, tag.owner, tag);
    const namesInGroup = new Map<string, string[]>();
    for (const tag of groupTags) {
        addTo(namesInGroup, tag.id, tag.name);
        if (tag.canonical_tag_id) addTo(namesInGroup, tag.canonical_tag_id, tag.name);
    }

    const built = await Promise.all(
        media.map(async (row): Promise<[string, BuiltSearchDocument]> => {
            const post = row.post_id ? postById.get(row.post_id) : undefined;
            const ownPostTags = post ? (tagsByOwner.get(post.id) ?? []) : [];
            const ownMediaTags = tagsByOwner.get(row.id) ?? [];
            const ownTags = [...ownPostTags, ...ownMediaTags];
            const directTags = new Set(ownTags.map((tag) => tag.name));
            const tagAliases = [...new Set(ownTags.flatMap((tag) => namesInGroup.get(canonicalId(tag)) ?? []))].filter(
                (name) => !directTags.has(name),
            );

            // A description of another library belongs to the media's previous library and is about to be replaced.
            const description = descriptionById.get(row.id);
            const stored = description?.input_hash && description.library_id === row.library_id ? description : null;

            // Plain values only: field labels would make every document match words like "title" or "tags". Tag names
            // are sorted because the hash decides whether a media is reindexed, and rows come back in no fixed order.
            const content = buildSearchContent([
                row.title,
                row.description,
                post?.title,
                post?.description,
                ownPostTags
                    .map((tag) => tag.name)
                    .sort()
                    .join(", "),
                ownMediaTags
                    .map((tag) => tag.name)
                    .sort()
                    .join(", "),
                tagAliases.sort().join(", "),
                stored?.scene,
                stored?.caption,
                stored?.ocr_text,
            ]);
            const document: SearchDocumentContent = {
                library_id: row.library_id,
                source: post?.source ?? row.source,
                media_type: row.type,
                title: row.title || post?.title || "",
                content,
            };
            return [row.id, { document, contentHash: await computeSha256(JSON.stringify(document)) }];
        }),
    );
    return new Map(built);
}
