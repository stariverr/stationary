import { type Transaction } from "@/global/db";
import { Post, Media, Author, DeleteStatus, SyncStatus, TagSource } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { avatarOrigin } from "@/features/author/avatar-pipeline";
import { originalCountError } from "@/features/media/originals";
import { releaseMediaAssets } from "@/features/media/release";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import { normalizeExternalId, assertUniqueExternalIds } from "@/lib/utils/media-identity";
import { syncImportedSources } from "./media-sources";
import type { PostItemData, MediaItemData } from "./schema";
import { loadTagLookup, syncEntityTags } from "./tag-sync";

export async function saveIngestMetadata(postData: PostItemData, targetLibraryId: string, workflowRunId: string, tx: Transaction) {
    const postExternalId = normalizeExternalId(postData.external_id, "post.external_id");
    const mediaItems = postData.media.map((media, index) => ({
        ...media,
        external_id: normalizeExternalId(media.external_id, `media[${index}].external_id`),
    }));
    assertUniqueExternalIds(
        mediaItems.map((media) => media.external_id),
        `media in post ${postExternalId}`,
    );
    // What the originals hold is only known once they are probed; the count is checked now.
    for (const [index, media] of mediaItems.entries()) {
        const countError = originalCountError(media.type, media.originals.length);
        if (countError) throw new Error(`media[${index}] ${countError}`);
    }

    // 1. Author logic
    let authorId: string | null = null;
    const avatarUrl = postData.author.avatar_file_url || null;
    if (postData.author.external_id && postData.platform) {
        try {
            const results = await tx
                .insert(Author)
                .values({
                    library_id: targetLibraryId,
                    eid: postData.author.external_id,
                    short_eid: postData.author.short_id ?? "",
                    signature: postData.author.signature ?? "",
                    nickname: postData.author.name,
                    platform: postData.platform,
                    avatar_source_url: avatarUrl,
                })
                .onConflictDoUpdate({
                    target: [Author.library_id, Author.platform, Author.eid],
                    set: {
                        nickname: postData.author.name,
                        short_eid: postData.author.short_id ?? undefined,
                        signature: postData.author.signature ?? undefined,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                        // A fresh avatar URL from the platform replaces any other wanted source.
                        ...(avatarUrl ? { avatar_source_url: avatarUrl, avatar_source_file_id: null } : {}),
                    },
                })
                .returning();
            const author = results[0];
            if (author) {
                authorId = author.id;
                const origin = avatarOrigin(author);
                if (origin && origin !== author.avatar_origin && origin !== author.avatar_error_origin) {
                    await markChanged(tx, Aspect.AUTHOR_AVATAR_SOURCE, [author.id]);
                }
            }
        } catch (e) {
            console.error(
                `[INGEST_DB] Failed to save/upsert author (platform=${postData.platform}, external_id=${postData.author.external_id}):`,
                e,
            );
        }
    }

    // 2. Post logic
    let postId: string;
    let existingPost = null;

    existingPost = await tx.query.Post.findFirst({
        where: {
            eid: postExternalId,
            source: postData.platform,
        },
    });

    if (existingPost && existingPost.library_id !== targetLibraryId) {
        throw new Error(`Post ${postExternalId} belongs to a different library`);
    }

    if (existingPost && (existingPost.delete_status === "DELETED" || existingPost.recycle_time !== null)) {
        return {
            postId: existingPost.id,
            authorId,
            mediaIds: [],
            skipUpdate: true,
        };
    }

    let hasPendingTasks = false;

    if (existingPost) {
        postId = existingPost.id;
        const postUpdateData: Partial<typeof Post.$inferInsert> = {
            title: postData.title,
            url: postData.url,
            description: postData.description,
            tags: postData.tags,
            author_name: postData.author.name,
            media_count: mediaItems.length,
            library_id: targetLibraryId,
            update_time: Temporal.Now.instant(),
        };
        if (postData.published_time) postUpdateData.published_time = postData.published_time;

        await tx.update(Post).set(postUpdateData).where(eq(Post.id, postId));
    } else {
        const postInsertData: typeof Post.$inferInsert = {
            eid: postExternalId,
            source: postData.platform,
            title: postData.title,
            description: postData.description,
            tags: postData.tags,
            author_name: postData.author.name,
            author_external_id: postData.author.external_id || "",
            author_id: authorId,
            media_count: mediaItems.length,
            library_id: targetLibraryId,
            update_time: Temporal.Now.instant(),
            url: postData.url,
            sync_status: SyncStatus.PENDING,
            last_error: null,
            workflow_run_id: workflowRunId,
        };
        const results = await tx.insert(Post).values(postInsertData).returning({ id: Post.id, eid: Post.eid });
        postId = results[0].id;
        hasPendingTasks = true;
    }

    const tagLookup =
        postData.tags?.length || mediaItems.some((media) => media.tags?.length) ? await loadTagLookup(targetLibraryId, tx) : undefined;

    await syncEntityTags(targetLibraryId, "post", postId, postData.tags || [], TagSource.SCRAPER, "post.tags", tagLookup, tx);

    // 3. Media sync
    const mediaEidSet = new Set(mediaItems.map((media) => media.external_id));
    const postMediaRecords = await tx.select().from(Media).where(eq(Media.post_id, postId));
    const activeMediaRecords = postMediaRecords.filter((media) => media.delete_status === DeleteStatus.ACTIVE);
    const previouslyDeletedMediaRecords = postMediaRecords.filter((media) => media.delete_status === DeleteStatus.DELETED);

    const mediaToDelete = activeMediaRecords.filter((media) => !mediaEidSet.has(media.eid));

    const mediaToDeleteIds = new Set(mediaToDelete.map((media) => media.id));
    if (mediaToDelete.length > 0) {
        const deleteTime = Temporal.Now.instant();
        const deletedMediaIds = [...mediaToDeleteIds];

        await tx
            .update(Media)
            .set({
                delete_status: DeleteStatus.DELETED,
                delete_time: deleteTime,
                update_time: deleteTime,
            })
            .where(and(inArray(Media.id, deletedMediaIds), eq(Media.delete_status, DeleteStatus.ACTIVE)));

        await releaseMediaAssets(tx, deletedMediaIds);

        hasPendingTasks = true;
    }

    const deletedMediaRecords = [...previouslyDeletedMediaRecords, ...mediaToDelete];
    const retainedActiveMedia = activeMediaRecords.filter((media) => !mediaToDeleteIds.has(media.id));
    const findMedia = (records: (typeof Media.$inferSelect)[], mediaData: MediaItemData) =>
        records.find((media) => media.eid === mediaData.external_id);
    const mediaIds: string[] = [];

    for (const [index, mediaData] of mediaItems.entries()) {
        const incomingPublishedTime = mediaData.published_time;
        const fallbackPublishedTime = incomingPublishedTime ?? postData.published_time;
        const media = findMedia(retainedActiveMedia, mediaData);

        if (!media && findMedia(deletedMediaRecords, mediaData)) {
            continue;
        }

        let mediaId: string;

        if (!media) {
            const insertedMedia = await tx
                .insert(Media)
                .values({
                    eid: mediaData.external_id,
                    post_id: postId,
                    library_id: targetLibraryId,
                    source: postData.platform,
                    title: mediaData.title || "",
                    description: mediaData.description || "",
                    type: mediaData.type,
                    sort_order: index,
                    published_time: fallbackPublishedTime,
                    sync_status: SyncStatus.PENDING,
                    update_time: Temporal.Now.instant(),
                })
                .returning({ id: Media.id });
            mediaId = insertedMedia[0].id;
            hasPendingTasks = true;
        } else {
            mediaId = media.id;
            const updateData: Partial<typeof Media.$inferInsert> = {
                sort_order: index,
                library_id: targetLibraryId,
                title: mediaData.title || "",
                description: mediaData.description || "",
                type: mediaData.type,
                update_time: Temporal.Now.instant(),
            };
            if (incomingPublishedTime || (!media.published_time && fallbackPublishedTime)) {
                updateData.published_time = incomingPublishedTime ?? fallbackPublishedTime;
            }
            await tx.update(Media).set(updateData).where(eq(Media.id, mediaId));
        }

        mediaIds.push(mediaId);
        await syncEntityTags(targetLibraryId, "media", mediaId, mediaData.tags || [], TagSource.SCRAPER, "media.tags", tagLookup, tx);

        // A media waiting for sources, or one whose last sync failed, goes back to the download pipeline.
        const needsDownload = await syncImportedSources(tx, { id: mediaId, type: mediaData.type }, mediaData);
        if (media && (needsDownload || media.sync_status !== SyncStatus.COMPLETED)) {
            await tx.update(Media).set({ sync_status: SyncStatus.PENDING, last_error: null }).where(eq(Media.id, mediaId));
            hasPendingTasks = true;
        }
    }

    if (hasPendingTasks && existingPost) {
        await tx
            .update(Post)
            .set({
                sync_status: SyncStatus.IN_PROGRESS,
                workflow_run_id: workflowRunId,
                last_error: null,
            })
            .where(eq(Post.id, postId));
    }

    return {
        postId,
        authorId,
        mediaIds,
        skipUpdate: false,
    };
}
