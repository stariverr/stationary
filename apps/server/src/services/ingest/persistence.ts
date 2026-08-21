import { type Transaction } from "@/global/db";
import { Post, Media, Track, Author, File, DeleteStatus, SyncStatus, TrackPurpose, TagSource, TrackType } from "@/db/schema";
import { eq, and, not, inArray } from "drizzle-orm";

import { normalizeExternalId, assertUniqueExternalIds } from "@/lib/utils/media-identity";
import { validateMediaComposition } from "@/lib/validation/media-composition";
import type { PostItemData, MediaItemData } from "@/api/schemas/ingest";

import {
    type ExistingTrack,
    type PreparedTrack,
    getTrackMetadataFields,
    prepareIncomingTracks,
    trackIdentityKey,
    trackNeedsProcessing,
    hasTrackPayloadChanged,
    getTrackPresentationUpdates,
    trackGroupKey,
} from "./track-metadata";
import { loadTagLookup, syncEntityTags } from "./tag-sync";

export async function syncPreparedTrack(
    tx: Transaction,
    mediaId: string,
    incoming: PreparedTrack,
    existing: ExistingTrack | undefined,
): Promise<boolean> {
    const now = Temporal.Now.instant();
    const presentationUpdates = existing ? getTrackPresentationUpdates(existing, incoming) : {};

    if (!incoming.url) {
        if (!existing || incoming.purpose === TrackPurpose.COVER) return false;

        const oldFileId = existing.file_id;
        await tx
            .update(Track)
            .set({
                ...presentationUpdates,
                source_url: null,
                file_id: null,
                sync_status: SyncStatus.COMPLETED,
                last_error: null,
                update_time: now,
            })
            .where(eq(Track.id, existing.id));
        if (oldFileId) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: now })
                .where(and(eq(File.id, oldFileId), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }
        return false;
    }

    if (!existing) {
        const metadataFields = getTrackMetadataFields(incoming);
        await tx.insert(Track).values({
            media_id: mediaId,
            type: incoming.type,
            purpose: incoming.purpose,
            is_original: incoming.is_original,
            quality: incoming.quality,
            priority: incoming.priority,
            source_url: incoming.url,
            metadata: incoming.metadata,
            sync_status: SyncStatus.PENDING,
            variant_key: incoming.variant_key,
            is_default: incoming.is_default,
            language: metadataFields.language,
            codec: metadataFields.codec,
            duration: incoming.duration,
            width: incoming.width,
            height: incoming.height,
            bandwidth: incoming.bandwidth,
            is_stale: false,
            container: incoming.format.container,
            is_fragmented: incoming.format.is_fragmented,
            stream_layout: incoming.format.stream_layout,
            has_video: incoming.format.has_video,
            has_audio: incoming.format.has_audio,
            streams: incoming.format.streams,
        });
        return true;
    }

    if (hasTrackPayloadChanged(existing, incoming)) {
        const metadataFields = getTrackMetadataFields(incoming);
        const oldFileId = existing.file_id;

        await tx
            .update(Track)
            .set({
                ...presentationUpdates,
                source_url: incoming.url,
                file_id: null,
                is_original: incoming.is_original,
                is_generated: false,
                quality: incoming.quality,
                priority: incoming.priority,
                metadata: incoming.metadata,
                sync_status: SyncStatus.PENDING,
                last_error: null,
                language: metadataFields.language,
                codec: metadataFields.codec,
                duration: incoming.duration,
                width: incoming.width,
                height: incoming.height,
                bandwidth: incoming.bandwidth,
                container: incoming.format.container,
                is_fragmented: incoming.format.is_fragmented,
                stream_layout: incoming.format.stream_layout,
                has_video: incoming.format.has_video,
                has_audio: incoming.format.has_audio,
                streams: incoming.format.streams,
                update_time: now,
            })
            .where(eq(Track.id, existing.id));
        if (oldFileId) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: now })
                .where(and(eq(File.id, oldFileId), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }
        return true;
    }

    if (Object.keys(presentationUpdates).length > 0) {
        await tx
            .update(Track)
            .set({ ...presentationUpdates, update_time: now })
            .where(eq(Track.id, existing.id));
    }

    return existing.sync_status === SyncStatus.PENDING;
}

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
    for (const [index, media] of mediaItems.entries()) {
        const compositionError = validateMediaComposition(
            media.type,
            prepareIncomingTracks(media.tracks).map((track) => ({
                type: track.type,
                purpose: track.purpose ?? TrackPurpose.CONTENT,
                is_default: track.is_default,
            })),
        );
        if (compositionError) {
            throw new Error(`media[${index}] ${compositionError}`);
        }
    }

    // 1. Author logic
    let authorId: string | null = null;
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
                })
                .onConflictDoUpdate({
                    target: [Author.library_id, Author.platform, Author.eid],
                    set: {
                        nickname: postData.author.name,
                        short_eid: postData.author.short_id ?? undefined,
                        signature: postData.author.signature ?? undefined,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                    },
                })
                .returning();
            const author = results[0];
            if (author) {
                authorId = author.id;
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

        const mediaFiles = await tx
            .select({ file_id: Track.file_id })
            .from(Track)
            .where(and(inArray(Track.media_id, deletedMediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));
        const fileIds = [...new Set(mediaFiles.map((mediaFile) => mediaFile.file_id).filter((id): id is string => Boolean(id)))];

        await tx
            .update(Track)
            .set({
                delete_status: DeleteStatus.DELETED,
                delete_time: deleteTime,
                update_time: deleteTime,
            })
            .where(and(inArray(Track.media_id, deletedMediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));

        if (fileIds.length > 0) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }

        hasPendingTasks = true;
    }

    const deletedMediaRecords = [...previouslyDeletedMediaRecords, ...mediaToDelete];
    const retainedActiveMedia = activeMediaRecords.filter((media) => !mediaToDeleteIds.has(media.id));
    const activeMediaIds = retainedActiveMedia.map((media) => media.id);
    const existingTracks = activeMediaIds.length > 0 ? await tx.select().from(Track).where(inArray(Track.media_id, activeMediaIds)) : [];
    const tracksByMediaId = new Map<string, ExistingTrack[]>();
    for (const track of existingTracks) {
        const mediaTracks = tracksByMediaId.get(track.media_id) ?? [];
        mediaTracks.push(track);
        tracksByMediaId.set(track.media_id, mediaTracks);
    }

    const findMedia = (records: (typeof Media.$inferSelect)[], mediaData: MediaItemData) =>
        records.find((media) => media.eid === mediaData.external_id);

    for (const [index, mediaData] of mediaItems.entries()) {
        const incomingPublishedTime = mediaData.published_time;
        const fallbackPublishedTime = incomingPublishedTime ?? postData.published_time;
        const media = findMedia(retainedActiveMedia, mediaData);

        if (!media && findMedia(deletedMediaRecords, mediaData)) {
            continue;
        }

        const tracksWithKeys = prepareIncomingTracks(mediaData.tracks);
        let mediaId: string;
        let existingMediaTracks: ExistingTrack[];

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
            existingMediaTracks = [];
            tracksByMediaId.set(mediaId, existingMediaTracks);
            hasPendingTasks = true;
        } else {
            mediaId = media.id;
            existingMediaTracks = tracksByMediaId.get(mediaId) ?? [];
            const activeTracks = existingMediaTracks.filter((track) => track.delete_status === DeleteStatus.ACTIVE);
            const existingTrackByKey = new Map(activeTracks.map((track) => [trackIdentityKey(track), track]));
            const incomingTrackKeys = new Set(tracksWithKeys.map(trackIdentityKey));
            const mediaNeedsProcessing =
                tracksWithKeys.some((track) => {
                    const existing = existingTrackByKey.get(trackIdentityKey(track));
                    return !existing || trackNeedsProcessing(existing, track);
                }) || activeTracks.some((track) => !incomingTrackKeys.has(trackIdentityKey(track)));

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
            if (media.sync_status === SyncStatus.FAILED || media.sync_status === SyncStatus.PENDING || mediaNeedsProcessing) {
                updateData.sync_status = SyncStatus.PENDING;
                updateData.last_error = null;
                hasPendingTasks = true;
            }

            if (Object.keys(updateData).length > 0) {
                await tx.update(Media).set(updateData).where(eq(Media.id, mediaId));
            }
        }

        await syncEntityTags(targetLibraryId, "media", mediaId, mediaData.tags || [], TagSource.SCRAPER, "media.tags", tagLookup, tx);

        const activeTracks = existingMediaTracks.filter((track) => track.delete_status === DeleteStatus.ACTIVE);
        const activeTrackByKey = new Map(activeTracks.map((track) => [trackIdentityKey(track), track]));
        const incomingTrackKeys = new Set(tracksWithKeys.map(trackIdentityKey));
        const obsoleteTracks = activeTracks.filter((track) => !incomingTrackKeys.has(trackIdentityKey(track)));
        if (obsoleteTracks.length > 0) {
            const deleteTime = Temporal.Now.instant();
            const obsoleteTrackIds = obsoleteTracks.map((track) => track.id);
            const obsoleteFileIds = [...new Set(obsoleteTracks.map((track) => track.file_id).filter((id): id is string => Boolean(id)))];

            await tx
                .update(Track)
                .set({
                    delete_status: DeleteStatus.DELETED,
                    delete_time: deleteTime,
                    update_time: deleteTime,
                })
                .where(and(inArray(Track.id, obsoleteTrackIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (obsoleteFileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, obsoleteFileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }
        }

        const trackGroups = new Map<string, { type: TrackType; purpose: TrackPurpose; defaultKey?: string }>();
        for (const track of tracksWithKeys) {
            const groupKey = trackGroupKey(track.type, track.purpose);
            const group = trackGroups.get(groupKey) ?? { type: track.type, purpose: track.purpose };
            if (track.is_default) group.defaultKey = track.variant_key;
            trackGroups.set(groupKey, group);
        }

        for (const group of trackGroups.values()) {
            const unsetCondition = [
                eq(Track.media_id, mediaId),
                eq(Track.type, group.type),
                eq(Track.purpose, group.purpose),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
            ];
            if (group.defaultKey) {
                unsetCondition.push(not(eq(Track.variant_key, group.defaultKey)));
            }

            await tx
                .update(Track)
                .set({ is_default: false })
                .where(and(...unsetCondition));
            for (const existing of activeTracks) {
                if (
                    existing.type === group.type &&
                    existing.purpose === group.purpose &&
                    (!group.defaultKey || existing.variant_key !== group.defaultKey)
                ) {
                    existing.is_default = false;
                }
            }
        }

        for (const track of tracksWithKeys) {
            const existing = activeTrackByKey.get(trackIdentityKey(track));
            if (await syncPreparedTrack(tx, mediaId, track, existing)) {
                hasPendingTasks = true;
            }
        }
    }

    if (authorId && postData.author.avatar_file_url) {
        const author = await tx.query.Author.findFirst({
            where: { id: authorId },
        });
        if (author && !author.avatar_file_id) {
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
        skipUpdate: false,
    };
}
