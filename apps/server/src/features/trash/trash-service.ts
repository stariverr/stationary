import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, SQL } from "drizzle-orm";
import { db } from "@/global/db";
import { Author, DeleteStatus, File as DbFile, Library, Media, MediaType, Post, PostSource, PostTag, Tag, TagStatus } from "@/db/schema";
import { batchDeletePost, batchRestorePost } from "@/features/post/lifecycle";
import { batchDeleteMedia, batchRestoreMedia } from "@/features/media/lifecycle";
import { MediaService, type PreviewItem } from "@/features/media/queries";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

export type TrashFilterType = "all" | "post" | "media";

export interface ListTrashParams {
    libraryId: string;
    type?: TrashFilterType;
    keyword?: string;
    page?: number;
    count?: number;
    sortBy?: "recycle_time";
    sortOrder?: "asc" | "desc";
}

export interface TrashPostItem {
    item_type: "post";
    id: string;
    library_id: string;
    eid: string;
    title: string;
    description: string;
    source: PostSource;
    author_name: string;
    author_avatar_url: string | null;
    create_time: string | null;
    published_time: string | null;
    recycle_time: string | null;
    media_count: number;
    covers: PreviewItem[];
    tags: string[];
}

export interface TrashMediaItem {
    item_type: "media";
    id: string;
    library_id: string;
    eid: string;
    title: string | null;
    description: string | null;
    source: PostSource;
    type: MediaType;
    create_time: string | null;
    published_time: string | null;
    recycle_time: string | null;
    covers: PreviewItem[];
    url: string | null;
}

export type TrashItem = TrashPostItem | TrashMediaItem;

export class TrashService {
    /**
     * Lists soft-deleted posts and standalone media in the recycle bin.
     */
    static async listTrashItems(params: ListTrashParams): Promise<{ list: TrashItem[]; total: number }> {
        const { libraryId, type = "all", keyword, page = 1, count: pageSize = 20, sortOrder = "desc" } = params;

        const offset = (page - 1) * pageSize;

        // Post query conditions
        const postConditions: SQL[] = [
            eq(Post.library_id, libraryId),
            eq(Post.delete_status, DeleteStatus.ACTIVE),
            isNotNull(Post.recycle_time),
        ];

        // Standalone Media query conditions (only unattached media or media not inside an active/trashed post)
        const mediaConditions: SQL[] = [
            eq(Media.library_id, libraryId),
            eq(Media.delete_status, DeleteStatus.ACTIVE),
            isNotNull(Media.recycle_time),
            isNull(Media.post_id),
        ];

        if (keyword && keyword.trim()) {
            const kw = `%${keyword.trim()}%`;
            postConditions.push(or(ilike(Post.title, kw), ilike(Post.description, kw))!);
            mediaConditions.push(or(ilike(Media.title, kw), ilike(Media.description, kw))!);
        }

        if (type === "post") {
            const totalResult = await db
                .select({ count: count() })
                .from(Post)
                .where(and(...postConditions));
            const total = totalResult[0]?.count ?? 0;

            const orderExpr = sortOrder === "asc" ? asc(Post.recycle_time) : desc(Post.recycle_time);

            const postRows = await db
                .select({
                    id: Post.id,
                    library_id: Post.library_id,
                    eid: Post.eid,
                    title: Post.title,
                    description: Post.description,
                    source: Post.source,
                    author_name: Post.author_name,
                    create_time: Post.create_time,
                    published_time: Post.published_time,
                    recycle_time: Post.recycle_time,
                    media_count: Post.media_count,
                    author_avatar_bucket: DbFile.bucket,
                    author_avatar_path: DbFile.path,
                })
                .from(Post)
                .leftJoin(Author, eq(Post.author_id, Author.id))
                .leftJoin(DbFile, eq(Author.avatar_file_id, DbFile.id))
                .where(and(...postConditions))
                .orderBy(orderExpr)
                .limit(pageSize)
                .offset(offset);

            const items = await this.hydratePostItems(postRows);
            return { list: items, total };
        }

        if (type === "media") {
            const totalResult = await db
                .select({ count: count() })
                .from(Media)
                .where(and(...mediaConditions));
            const total = totalResult[0]?.count ?? 0;

            const orderExpr = sortOrder === "asc" ? asc(Media.recycle_time) : desc(Media.recycle_time);

            const mediaRows = await db
                .select({
                    id: Media.id,
                    library_id: Media.library_id,
                    eid: Media.eid,
                    title: Media.title,
                    description: Media.description,
                    source: Media.source,
                    type: Media.type,
                    create_time: Media.create_time,
                    published_time: Media.published_time,
                    recycle_time: Media.recycle_time,
                })
                .from(Media)
                .where(and(...mediaConditions))
                .orderBy(orderExpr)
                .limit(pageSize)
                .offset(offset);

            const items = await this.hydrateMediaItems(mediaRows);
            return { list: items, total };
        }

        // type === "all": Union posts and standalone media
        const [postCountResult, mediaCountResult] = await Promise.all([
            db
                .select({ count: count() })
                .from(Post)
                .where(and(...postConditions)),
            db
                .select({ count: count() })
                .from(Media)
                .where(and(...mediaConditions)),
        ]);
        const total = (postCountResult[0]?.count ?? 0) + (mediaCountResult[0]?.count ?? 0);

        if (total === 0) {
            return { list: [], total: 0 };
        }

        // Fetch IDs and types ordered by recycle_time
        const postSelect = db
            .select({
                id: Post.id,
                item_type: sql<string>`'post'`.as("item_type"),
                recycle_time: Post.recycle_time,
            })
            .from(Post)
            .where(and(...postConditions));

        const mediaSelect = db
            .select({
                id: Media.id,
                item_type: sql<string>`'media'`.as("item_type"),
                recycle_time: Media.recycle_time,
            })
            .from(Media)
            .where(and(...mediaConditions));

        const unionQuery = postSelect.unionAll(mediaSelect);
        const orderDirection = sortOrder === "asc" ? sql`asc` : sql`desc`;

        const pagedRows = await db
            .select()
            .from(unionQuery.as("trash_items"))
            .orderBy(sql`recycle_time ${orderDirection}`)
            .limit(pageSize)
            .offset(offset);

        const postIds = pagedRows.filter((r) => r.item_type === "post").map((r) => r.id);
        const mediaIds = pagedRows.filter((r) => r.item_type === "media").map((r) => r.id);

        const [postsData, mediaData] = await Promise.all([
            postIds.length > 0
                ? db
                      .select({
                          id: Post.id,
                          library_id: Post.library_id,
                          eid: Post.eid,
                          title: Post.title,
                          description: Post.description,
                          source: Post.source,
                          author_name: Post.author_name,
                          create_time: Post.create_time,
                          published_time: Post.published_time,
                          recycle_time: Post.recycle_time,
                          media_count: Post.media_count,
                          author_avatar_bucket: DbFile.bucket,
                          author_avatar_path: DbFile.path,
                      })
                      .from(Post)
                      .leftJoin(Author, eq(Post.author_id, Author.id))
                      .leftJoin(DbFile, eq(Author.avatar_file_id, DbFile.id))
                      .where(inArray(Post.id, postIds))
                : Promise.resolve([]),
            mediaIds.length > 0
                ? db
                      .select({
                          id: Media.id,
                          library_id: Media.library_id,
                          eid: Media.eid,
                          title: Media.title,
                          description: Media.description,
                          source: Media.source,
                          type: Media.type,
                          create_time: Media.create_time,
                          published_time: Media.published_time,
                          recycle_time: Media.recycle_time,
                      })
                      .from(Media)
                      .where(inArray(Media.id, mediaIds))
                : Promise.resolve([]),
        ]);

        const [hydratedPosts, hydratedMedia] = await Promise.all([this.hydratePostItems(postsData), this.hydrateMediaItems(mediaData)]);

        const postMap = new Map(hydratedPosts.map((p) => [p.id, p]));
        const mediaMap = new Map(hydratedMedia.map((m) => [m.id, m]));

        const combinedList: TrashItem[] = [];
        for (const row of pagedRows) {
            if (row.item_type === "post") {
                const item = postMap.get(row.id);
                if (item) combinedList.push(item);
            } else {
                const item = mediaMap.get(row.id);
                if (item) combinedList.push(item);
            }
        }

        return { list: combinedList, total };
    }

    /**
     * Batch restores posts and media from recycle bin.
     */
    static async batchRestore(params: {
        libraryId: string;
        ownerId: string;
        postIds?: string[];
        mediaIds?: string[];
    }): Promise<{ restored_posts: number; restored_media: number }> {
        const { libraryId, ownerId, postIds = [], mediaIds = [] } = params;

        // Verify library ownership
        const [library] = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(eq(Library.id, libraryId), eq(Library.owner_id, ownerId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);

        if (!library) {
            throw new Error("Library not found or access denied");
        }

        let restoredPosts = 0;
        let restoredMedia = 0;

        if (postIds.length > 0) {
            const validPosts = await db
                .select({ id: Post.id })
                .from(Post)
                .where(
                    and(
                        inArray(Post.id, postIds),
                        eq(Post.library_id, libraryId),
                        eq(Post.delete_status, DeleteStatus.ACTIVE),
                        isNotNull(Post.recycle_time),
                    ),
                );

            if (validPosts.length > 0) {
                const res = await batchRestorePost(validPosts.map((p) => p.id));
                restoredPosts = res.postUpdated;
            }
        }

        if (mediaIds.length > 0) {
            const validMedia = await db
                .select({ id: Media.id })
                .from(Media)
                .where(
                    and(
                        inArray(Media.id, mediaIds),
                        eq(Media.library_id, libraryId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        isNotNull(Media.recycle_time),
                    ),
                );

            if (validMedia.length > 0) {
                const res = await batchRestoreMedia(validMedia.map((m) => m.id));
                restoredMedia = res.mediaUpdated;
            }
        }

        return { restored_posts: restoredPosts, restored_media: restoredMedia };
    }

    /**
     * Batch permanently deletes posts and media from recycle bin.
     */
    static async batchDelete(params: {
        libraryId: string;
        ownerId: string;
        postIds?: string[];
        mediaIds?: string[];
    }): Promise<{ deleted_posts: number; deleted_media: number }> {
        const { libraryId, ownerId, postIds = [], mediaIds = [] } = params;

        // Verify library ownership
        const [library] = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(eq(Library.id, libraryId), eq(Library.owner_id, ownerId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);

        if (!library) {
            throw new Error("Library not found or access denied");
        }

        let deletedPosts = 0;
        let deletedMedia = 0;

        if (postIds.length > 0) {
            const validPosts = await db
                .select({ id: Post.id })
                .from(Post)
                .where(
                    and(
                        inArray(Post.id, postIds),
                        eq(Post.library_id, libraryId),
                        eq(Post.delete_status, DeleteStatus.ACTIVE),
                        isNotNull(Post.recycle_time),
                    ),
                );

            if (validPosts.length > 0) {
                const res = await batchDeletePost(validPosts.map((p) => p.id));
                deletedPosts = res.postUpdated;
            }
        }

        if (mediaIds.length > 0) {
            const validMedia = await db
                .select({ id: Media.id })
                .from(Media)
                .where(
                    and(
                        inArray(Media.id, mediaIds),
                        eq(Media.library_id, libraryId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        isNotNull(Media.recycle_time),
                    ),
                );

            if (validMedia.length > 0) {
                const res = await batchDeleteMedia(validMedia.map((m) => m.id));
                deletedMedia = res.mediaUpdated;
            }
        }

        return { deleted_posts: deletedPosts, deleted_media: deletedMedia };
    }

    /**
     * Empties all trashed posts and media in a library permanently.
     */
    static async emptyTrash(params: { libraryId: string; ownerId: string }): Promise<{ deleted_posts: number; deleted_media: number }> {
        const { libraryId, ownerId } = params;

        // Verify library ownership
        const [library] = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(eq(Library.id, libraryId), eq(Library.owner_id, ownerId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);

        if (!library) {
            throw new Error("Library not found or access denied");
        }

        const trashedPosts = await db
            .select({ id: Post.id })
            .from(Post)
            .where(and(eq(Post.library_id, libraryId), eq(Post.delete_status, DeleteStatus.ACTIVE), isNotNull(Post.recycle_time)));

        let deletedPosts = 0;
        if (trashedPosts.length > 0) {
            const res = await batchDeletePost(trashedPosts.map((p) => p.id));
            deletedPosts = res.postUpdated;
        }

        const trashedMedia = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNotNull(Media.recycle_time)));

        let deletedMedia = 0;
        if (trashedMedia.length > 0) {
            const res = await batchDeleteMedia(trashedMedia.map((m) => m.id));
            deletedMedia = res.mediaUpdated;
        }

        return { deleted_posts: deletedPosts, deleted_media: deletedMedia };
    }

    /**
     * Helper to hydrate post items with preview covers and tags.
     */
    private static async hydratePostItems(
        posts: Array<{
            id: string;
            library_id: string;
            eid: string;
            title: string;
            description: string;
            source: PostSource;
            author_name: string;
            create_time: Temporal.Instant;
            published_time: Temporal.Instant | null;
            recycle_time: Temporal.Instant | null;
            media_count: number;
            author_avatar_bucket: string | null;
            author_avatar_path: string | null;
        }>,
    ): Promise<TrashPostItem[]> {
        if (posts.length === 0) return [];

        const postIds = posts.map((p) => p.id);

        // Fetch cover media for each post
        const mediaRows = await db
            .select({
                id: Media.id,
                post_id: Media.post_id,
                type: Media.type,
                sort_order: Media.sort_order,
            })
            .from(Media)
            .where(and(inArray(Media.post_id, postIds), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .orderBy(asc(Media.sort_order));

        const allMediaIds = mediaRows.map((mr) => mr.id);
        const coversByMediaId = await MediaService.getCoversMap(allMediaIds);

        const coversByPostId = new Map<string, PreviewItem[]>();
        for (const mr of mediaRows) {
            if (!mr.post_id) continue;
            const covers = coversByMediaId.get(mr.id) || [];
            if (covers.length > 0 && !coversByPostId.has(mr.post_id)) {
                coversByPostId.set(mr.post_id, covers);
            }
        }

        // Fetch active tags
        const tagRows = await db
            .select({
                post_id: PostTag.post_id,
                tag_name: Tag.name,
            })
            .from(PostTag)
            .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
            .where(and(inArray(PostTag.post_id, postIds), eq(Tag.status, TagStatus.ACTIVE)))
            .orderBy(asc(PostTag.id));

        const tagsByPostId = new Map<string, string[]>();
        for (const tr of tagRows) {
            let list = tagsByPostId.get(tr.post_id);
            if (!list) {
                list = [];
                tagsByPostId.set(tr.post_id, list);
            }
            list.push(tr.tag_name);
        }

        return posts.map((p) => ({
            item_type: "post",
            id: p.id,
            library_id: p.library_id,
            eid: p.eid,
            title: p.title,
            description: p.description,
            source: p.source,
            author_name: p.author_name,
            author_avatar_url: buildCdnUrl(p.author_avatar_bucket, p.author_avatar_path),
            create_time: toIsoTimestamp(p.create_time),
            published_time: toIsoTimestamp(p.published_time),
            recycle_time: toIsoTimestamp(p.recycle_time),
            media_count: p.media_count,
            covers: coversByPostId.get(p.id) || [],
            tags: tagsByPostId.get(p.id) || [],
        }));
    }

    /**
     * Helper to hydrate standalone media items with preview covers.
     */
    private static async hydrateMediaItems(
        mediaList: Array<{
            id: string;
            library_id: string;
            eid: string;
            title: string;
            description: string;
            source: PostSource;
            type: MediaType;
            create_time: Temporal.Instant;
            published_time: Temporal.Instant | null;
            recycle_time: Temporal.Instant | null;
        }>,
    ): Promise<TrashMediaItem[]> {
        if (mediaList.length === 0) return [];

        const mediaIds = mediaList.map((m) => m.id);
        const coversByMediaId = await MediaService.getCoversMap(mediaIds);

        return mediaList.map((m) => ({
            item_type: "media",
            id: m.id,
            library_id: m.library_id,
            eid: m.eid,
            title: m.title,
            description: m.description,
            source: m.source,
            type: m.type,
            create_time: toIsoTimestamp(m.create_time),
            published_time: toIsoTimestamp(m.published_time),
            recycle_time: toIsoTimestamp(m.recycle_time),
            covers: coversByMediaId.get(m.id) || [],
            url: null,
        }));
    }
}
