import { eq, inArray, or } from "drizzle-orm";
import { Media, MediaTag, PostTag, Tag } from "@/db/schema";
import type { DbClient } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";

/**
 * Reports a change of what media are described by (their own or their post's title, description and tags) for the
 * search documents built from it. Call these in the transaction that makes the change.
 */
export async function markMediaMetaChanged(client: DbClient, mediaIds: readonly string[]): Promise<void> {
    await markChanged(client, Aspect.MEDIA_META, mediaIds);
}

/** A post's title, description or tags changed: its media are affected. */
export async function markPostMetaChanged(client: DbClient, postIds: readonly string[]): Promise<void> {
    if (postIds.length === 0) return;
    const media = await client
        .select({ id: Media.id })
        .from(Media)
        .where(inArray(Media.post_id, [...postIds]));
    await markMediaMetaChanged(
        client,
        media.map((row) => row.id),
    );
}

/**
 * The media whose search documents name one of the tags: tagged directly or through their post, with any tag of the
 * same alias group (documents list a tag's aliases too). Read it before links are removed.
 */
export async function mediaOfTags(client: DbClient, tagIds: readonly string[]): Promise<string[]> {
    if (tagIds.length === 0) return [];
    const tags = await client
        .select({ id: Tag.id, canonical: Tag.canonical_tag_id })
        .from(Tag)
        .where(inArray(Tag.id, [...tagIds]));
    const groups = [...new Set([...tagIds, ...tags.map((tag) => tag.canonical ?? tag.id)])];
    const group = await client
        .select({ id: Tag.id })
        .from(Tag)
        .where(or(inArray(Tag.id, groups), inArray(Tag.canonical_tag_id, groups)));
    const ids = group.map((tag) => tag.id);
    if (ids.length === 0) return [];

    const [direct, viaPost] = await Promise.all([
        client.selectDistinct({ id: MediaTag.media_id }).from(MediaTag).where(inArray(MediaTag.tag_id, ids)),
        client
            .selectDistinct({ id: Media.id })
            .from(PostTag)
            .innerJoin(Media, eq(Media.post_id, PostTag.post_id))
            .where(inArray(PostTag.tag_id, ids)),
    ]);
    return [...new Set([...direct, ...viaPost].map((row) => row.id))];
}
