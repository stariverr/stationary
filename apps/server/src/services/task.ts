import { db, type Transaction } from "@/global/db";
export type DbExecutor = typeof db | Transaction;
import {
    Post,
    Media,
    Track,
    Author,
    File,
    DeleteStatus,
    SyncStatus,
    TrackType,
    TrackPurpose,
    Tag,
    PostTag,
    MediaTag,
    TagStatus,
    TagSource,
    MediaType,
    AsyncTaskType,
    AsyncTaskUnitKind,
    AsyncSubjectType,
} from "@/db/schema";
import { eq, and, not, inArray, isNull, isNotNull, or, lt } from "drizzle-orm";
import { downloadStream, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";
import { extractSegmentBase } from "@/lib/utils/mp4-segment";
import { withLock } from "@/lib/utils/lock";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import type { PostItemData, MediaItemData } from "@/api/task";

import { Temporal } from "@js-temporal/polyfill";
import { sanitizeTags } from "@/lib/utils/tag_sanitizer";
import { generateDeterministicVariantKey } from "@/lib/utils/track";
import { deriveTrackFormat, normalizeIncomingTrack, type TrackFormatFields } from "@/lib/utils/track-format";
import { normalizeExternalId, assertUniqueExternalIds } from "@/lib/utils/media-identity";
import { validateMediaComposition } from "@/lib/validation/media-composition";

import { MediaService } from "@/services/media";

type TagRecord = typeof Tag.$inferSelect;
type TagLookup = Map<string, TagRecord>;
type TrackMetadataFields = {
    language?: string | null;
    codec?: string | null;
};

function getTrackMetadataFields(track: { language?: unknown; codec?: unknown }): TrackMetadataFields {
    return {
        language: typeof track.language === "string" ? track.language : null,
        codec: typeof track.codec === "string" ? track.codec : null,
    };
}

async function loadTagLookup(executor: DbExecutor, libraryId: string): Promise<TagLookup> {
    const existingTags = await executor.select().from(Tag).where(eq(Tag.library_id, libraryId));
    return new Map(existingTags.map((tag) => [tag.normalized_name, tag]));
}

async function syncEntityTags(
    executor: DbExecutor,
    libraryId: string,
    entityType: "post" | "media",
    entityId: string,
    rawTags: string[],
    source: TagSource,
    sourceField: string,
    tagLookup?: TagLookup,
) {
    const sanitized = sanitizeTags(rawTags);
    if (sanitized.length === 0) {
        if (entityType === "post") {
            await executor.delete(PostTag).where(eq(PostTag.post_id, entityId));
        } else {
            await executor.delete(MediaTag).where(eq(MediaTag.media_id, entityId));
        }
        return;
    }

    const normalizedLookup = tagLookup ?? (await loadTagLookup(executor, libraryId));

    const targetTagIds: string[] = [];
    const missingItems: typeof sanitized = [];

    for (const item of sanitized) {
        const matched = normalizedLookup.get(item.normalized);
        if (matched) {
            if (matched.status !== TagStatus.IGNORED) {
                targetTagIds.push(matched.id);
            }
        } else {
            missingItems.push(item);
        }
    }

    if (missingItems.length > 0) {
        const insertedTags = await executor
            .insert(Tag)
            .values(
                missingItems.map((item) => ({
                    name: item.name,
                    normalized_name: item.normalized,
                    canonical_tag_id: null,
                    library_id: libraryId,
                    status: TagStatus.CANDIDATE,
                    source: source,
                    source_field: sourceField,
                })),
            )
            .returning();

        for (const inserted of insertedTags) {
            targetTagIds.push(inserted.id);
            normalizedLookup.set(inserted.normalized_name, inserted);
        }
    }

    if (entityType === "post") {
        const existingLinks = await executor.select({ tag_id: PostTag.tag_id }).from(PostTag).where(eq(PostTag.post_id, entityId));
        const existingTagIds = existingLinks.map((l) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await executor.insert(PostTag).values(
                toAdd.map((tagId) => ({
                    post_id: entityId,
                    tag_id: tagId,
                })),
            );
        }
        if (toDelete.length > 0) {
            await executor.delete(PostTag).where(and(eq(PostTag.post_id, entityId), inArray(PostTag.tag_id, toDelete)));
        }
    } else {
        const existingLinks = await executor.select({ tag_id: MediaTag.tag_id }).from(MediaTag).where(eq(MediaTag.media_id, entityId));
        const existingTagIds = existingLinks.map((l) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await executor.insert(MediaTag).values(
                toAdd.map((tagId) => ({
                    media_id: entityId,
                    tag_id: tagId,
                })),
            );
        }
        if (toDelete.length > 0) {
            await executor.delete(MediaTag).where(and(eq(MediaTag.media_id, entityId), inArray(MediaTag.tag_id, toDelete)));
        }
    }
}

type IncomingTrack = MediaItemData["tracks"][number];
type ExistingTrack = typeof Track.$inferSelect;

type PreparedTrack = IncomingTrack & {
    variant_key: string;
    is_default: boolean;
    format: TrackFormatFields;
    metadata_signature: string;
    streams_signature: string;
    priority: number;
    language: string | null;
    codec: string | null;
    duration: number | null;
    width: number | null;
    height: number | null;
    bandwidth: number | null;
};

const trackGroupKey = (type: TrackType, purpose: TrackPurpose) => `${type}:${purpose}`;

const trackIdentityKey = (track: Pick<IncomingTrack, "type" | "purpose"> & { variant_key: string }) =>
    `${trackGroupKey(track.type, track.purpose)}:${track.variant_key}`;

function prepareIncomingTracks(tracks: IncomingTrack[]): PreparedTrack[] {
    const prepared = tracks.map((track) => {
        const normalized = normalizeIncomingTrack(track);
        const baseKey = generateDeterministicVariantKey(
            {
                type: track.type,
                purpose: track.purpose,
                quality: track.quality,
                priority: normalized.priority,
                is_original: normalized.is_original,
                metadata: track.metadata,
                language: normalized.language ?? undefined,
                codec: normalized.codec ?? undefined,
                width: normalized.width,
                height: normalized.height,
            },
            null,
        );

        return {
            ...track,
            priority: normalized.priority,
            language: normalized.language,
            codec: normalized.codec,
            duration: normalized.duration,
            width: normalized.width,
            height: normalized.height,
            bandwidth: normalized.bandwidth,
            metadata: normalized.metadata,
            baseKey,
            format: normalized.format,
            metadata_signature: JSON.stringify(normalized.metadata),
            streams_signature: JSON.stringify(normalized.format.streams),
        };
    });

    const seenKeys = new Set<string>();
    const defaultKeys = new Map<string, string>();
    const keyedTracks = prepared.map(({ baseKey, ...track }) => {
        let variantKey = baseKey;
        let duplicateIndex = 1;
        const duplicateKey = () => `${trackIdentityKey({ ...track, variant_key: variantKey })}`;

        while (seenKeys.has(duplicateKey())) {
            duplicateIndex += 1;
            variantKey = `${baseKey}-dup-${duplicateIndex}`;
        }
        seenKeys.add(duplicateKey());

        return {
            ...track,
            variant_key: variantKey,
        };
    });

    for (const track of keyedTracks) {
        if (track.priority === 0) {
            const groupKey = trackGroupKey(track.type, track.purpose);
            if (!defaultKeys.has(groupKey)) defaultKeys.set(groupKey, track.variant_key);
        }
    }

    return keyedTracks.map((track) => ({
        ...track,
        is_default: defaultKeys.get(trackGroupKey(track.type, track.purpose)) === track.variant_key,
    }));
}

function hasTrackPayloadChanged(existing: ExistingTrack, incoming: PreparedTrack): boolean {
    const metadataFields = getTrackMetadataFields(incoming);
    return (
        existing.source_url !== incoming.url ||
        existing.is_original !== incoming.is_original ||
        existing.quality !== incoming.quality ||
        existing.sync_status === SyncStatus.FAILED ||
        existing.language !== metadataFields.language ||
        existing.codec !== metadataFields.codec ||
        existing.container !== incoming.format.container ||
        existing.is_fragmented !== incoming.format.is_fragmented ||
        existing.stream_layout !== incoming.format.stream_layout ||
        existing.has_video !== incoming.format.has_video ||
        existing.has_audio !== incoming.format.has_audio ||
        JSON.stringify(existing.streams || []) !== incoming.streams_signature ||
        JSON.stringify(existing.metadata || {}) !== incoming.metadata_signature
    );
}

function trackNeedsProcessing(existing: ExistingTrack, incoming: PreparedTrack): boolean {
    return existing.sync_status === SyncStatus.PENDING || hasTrackPayloadChanged(existing, incoming);
}

function getTrackPresentationUpdates(existing: ExistingTrack, incoming: PreparedTrack): Partial<typeof Track.$inferInsert> {
    const updates: Partial<typeof Track.$inferInsert> = {};
    if (existing.priority !== incoming.priority) updates.priority = incoming.priority;
    if (existing.is_default !== incoming.is_default) updates.is_default = incoming.is_default;
    return updates;
}

async function syncPreparedTrack(
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

export const TaskService = {
    /**
     * Step 1: Save metadata to DB (Synchronization & Deduplication)
     */
    async saveMetadata(postData: PostItemData, targetLibraryId: string, workflowRunId: string, tx: Transaction) {
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
                    `[TASK_SERVICE] Failed to save/upsert author (platform=${postData.platform}, external_id=${postData.author.external_id}):`,
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

            // Always update post metadata to reflect the latest scraped text/tags
            await tx.update(Post).set(postUpdateData).where(eq(Post.id, postId));
        } else {
            // Post not exists, create new one
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
            postData.tags?.length || mediaItems.some((media) => media.tags?.length) ? await loadTagLookup(tx, targetLibraryId) : undefined;

        // Sync relational tags for post
        await syncEntityTags(tx, targetLibraryId, "post", postId, postData.tags || [], TagSource.SCRAPER, "post.tags", tagLookup);

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
        const existingTracks =
            activeMediaIds.length > 0 ? await tx.select().from(Track).where(inArray(Track.media_id, activeMediaIds)) : [];
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

            // Sync relational tags for media
            await syncEntityTags(tx, targetLibraryId, "media", mediaId, mediaData.tags || [], TagSource.SCRAPER, "media.tags", tagLookup);

            const activeTracks = existingMediaTracks.filter((track) => track.delete_status === DeleteStatus.ACTIVE);
            const activeTrackByKey = new Map(activeTracks.map((track) => [trackIdentityKey(track), track]));
            const incomingTrackKeys = new Set(tracksWithKeys.map(trackIdentityKey));
            const obsoleteTracks = activeTracks.filter((track) => !incomingTrackKeys.has(trackIdentityKey(track)));
            if (obsoleteTracks.length > 0) {
                const deleteTime = Temporal.Now.instant();
                const obsoleteTrackIds = obsoleteTracks.map((track) => track.id);
                const obsoleteFileIds = [
                    ...new Set(obsoleteTracks.map((track) => track.file_id).filter((id): id is string => Boolean(id))),
                ];

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

        // 4. Check if Avatar needs processing
        if (authorId && postData.author.avatar_file_url) {
            const author = await tx.query.Author.findFirst({
                where: { id: authorId },
            });
            if (author && !author.avatar_file_id) {
                hasPendingTasks = true;
            }
        }

        // 5. Trigger Workflow if needed
        if (hasPendingTasks && existingPost) {
            await tx
                .update(Post)
                .set({
                    sync_status: SyncStatus.IN_PROGRESS,
                    workflow_run_id: workflowRunId,
                    last_error: null,
                    update_time: Temporal.Now.instant(),
                })
                .where(eq(Post.id, postId));
        }

        return { postId, authorId, skipUpdate: !hasPendingTasks };
    },

    /**
     * Process individual media by media ID directly
     */
    async processMediaById(mediaId: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const mediaRecords = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .limit(1);
        const m = mediaRecords[0];
        if (!m) return;
        return this.processMedia(m.id, signal);
    },

    /**
     * Step 2: Process individual media
     */
    async processMedia(mediaId: string, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const mediaRecords = await db
            .select()
            .from(Media)
            .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)))
            .limit(1);
        const m = mediaRecords[0];
        if (!m) return;

        const lockKey = `lock:media:${m.id}`;

        await withLock(
            lockKey,
            async (lockSignal) => {
                try {
                    lockSignal.throwIfAborted();
                    await db
                        .update(Media)
                        .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                        .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                    // Fetch again to ensure we get latest active tracks
                    const tracks = await db
                        .select()
                        .from(Track)
                        .where(and(eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                    let allCompleted = true;

                    for (const mf of tracks) {
                        lockSignal.throwIfAborted();
                        // Already completed or no source URL, skipping.
                        if (mf.sync_status === SyncStatus.COMPLETED || !mf.source_url) continue;

                        const [activeMedia] = await db
                            .select({ id: Media.id })
                            .from(Media)
                            .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                            .limit(1);
                        if (!activeMedia) return;

                        const [activeTrack] = await db
                            .select({ id: Track.id })
                            .from(Track)
                            .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                            .limit(1);
                        if (!activeTrack) continue;

                        // Mark as IN_PROGRESS
                        await db
                            .update(Track)
                            .set({ sync_status: SyncStatus.IN_PROGRESS, update_time: Temporal.Now.instant() })
                            .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));

                        try {
                            const response = await downloadStream(mf.source_url, { signal: lockSignal });
                            if (response) {
                                lockSignal.throwIfAborted();
                                let contentType = response.headers.get("Content-Type");
                                let contentLength = response.headers.get("Content-Length");
                                let ext = getExtensionFromContentType(contentType, mf.source_url);
                                let responseBody: ReadableStream | Uint8Array;

                                if (!response.body) {
                                    throw new Error("Response body is empty");
                                }
                                responseBody = response.body;

                                let segmentBase: { initialization: string; index_range: string } | undefined;
                                if (
                                    (mf.type === TrackType.VIDEO || mf.type === TrackType.AUDIO) &&
                                    responseBody instanceof ReadableStream
                                ) {
                                    const res = await extractSegmentBase(responseBody);
                                    segmentBase = res.segment_base;
                                    responseBody = res.stream;
                                }

                                let prefix = "";
                                if (mf.type === TrackType.VIDEO && mf.purpose === TrackPurpose.CONTENT) {
                                    prefix = `video_${mf.variant_key}`;
                                } else if (mf.type === TrackType.AUDIO && mf.purpose === TrackPurpose.CONTENT) {
                                    prefix = `audio_${mf.variant_key}`;
                                } else if (mf.purpose === TrackPurpose.COVER) {
                                    prefix = "cover";
                                } else if (mf.type === TrackType.SUBTITLE && mf.purpose === TrackPurpose.CONTENT) {
                                    prefix = `subtitle_${mf.variant_key}`;
                                } else if (mf.type === TrackType.IMAGE && mf.purpose === TrackPurpose.CONTENT) {
                                    prefix = `image_${mf.variant_key}`;
                                } else {
                                    prefix = `track_${mf.variant_key}`;
                                }

                                const path = m.post_id
                                    ? `v2/p/${m.post_id.slice(-2)}/${m.post_id}/media_${m.id}/${prefix}.${ext}`
                                    : `v2/m/${m.id.slice(-2)}/${m.id}/${prefix}.${ext}`;

                                const S3Data = responseBody;
                                await uploadToS3(
                                    path,
                                    S3Data,
                                    contentType || "application/octet-stream",
                                    env.S3_BUCKET,
                                    contentLength ? parseInt(contentLength) : undefined,
                                    lockSignal,
                                );
                                lockSignal.throwIfAborted();

                                const [activeTrackBeforePersist] = await db
                                    .select({ id: Track.id })
                                    .from(Track)
                                    .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                                    .limit(1);
                                if (!activeTrackBeforePersist) return;

                                const size = contentLength ? parseInt(contentLength) : null;

                                const fileResults = await db
                                    .insert(File)
                                    .values({
                                        path: path,
                                        mime_type: contentType || "application/octet-stream",
                                        extension: ext,
                                        bucket: env.S3_BUCKET,
                                        size: size,
                                    })
                                    .onConflictDoUpdate({
                                        target: File.path,
                                        set: {
                                            mime_type: contentType || "application/octet-stream",
                                            extension: ext,
                                            size: size,
                                            delete_status: DeleteStatus.ACTIVE,
                                            delete_time: null,
                                        },
                                    })
                                    .returning({ id: File.id });

                                const updatedMetadata = {
                                    ...mf.metadata,
                                };
                                if (segmentBase) {
                                    updatedMetadata.segment_base = segmentBase;
                                }
                                const format = deriveTrackFormat({
                                    type: mf.type,
                                    metadata: updatedMetadata,
                                    container: mf.container,
                                    is_fragmented: mf.is_fragmented,
                                    stream_layout: mf.stream_layout,
                                    has_video: mf.has_video,
                                    has_audio: mf.has_audio,
                                    streams: mf.streams,
                                    file: {
                                        mime_type: contentType,
                                        extension: ext,
                                    },
                                });

                                const width = mf.width;
                                const height = mf.height;
                                const duration = mf.duration;
                                const bandwidth = mf.bandwidth;

                                const updatedTracks = await db
                                    .update(Track)
                                    .set({
                                        file_id: fileResults[0].id,
                                        sync_status: SyncStatus.COMPLETED,
                                        last_error: null,
                                        metadata: updatedMetadata,
                                        container: format.container,
                                        is_fragmented: format.is_fragmented,
                                        stream_layout: format.stream_layout,
                                        has_video: format.has_video,
                                        has_audio: format.has_audio,
                                        streams: format.streams,
                                        width: width,
                                        height: height,
                                        duration: duration,
                                        bandwidth: bandwidth,
                                        update_time: Temporal.Now.instant(),
                                    })
                                    .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                                    .returning({ id: Track.id });

                                if (updatedTracks.length === 0) {
                                    await db
                                        .update(File)
                                        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                                        .where(and(eq(File.id, fileResults[0].id), eq(File.delete_status, DeleteStatus.ACTIVE)));
                                    return;
                                }
                                if (mf.file_id && mf.file_id !== fileResults[0].id) {
                                    await db
                                        .update(File)
                                        .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                                        .where(and(eq(File.id, mf.file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
                                }
                            }
                        } catch (e) {
                            if (lockSignal.aborted) throw e;
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            await db
                                .update(Track)
                                .set({
                                    sync_status: SyncStatus.FAILED,
                                    last_error: errorMsg,
                                    update_time: Temporal.Now.instant(),
                                })
                                .where(and(eq(Track.id, mf.id), eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                            allCompleted = false;
                            throw e;
                        }
                    }

                    const completionError = await MediaService.getMediaCompletionError(m.id, true);
                    if (allCompleted && !completionError) {
                        lockSignal.throwIfAborted();
                        await db
                            .update(Media)
                            .set({ sync_status: SyncStatus.COMPLETED, last_error: null, update_time: Temporal.Now.instant() })
                            .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                        // Trigger cover generation asynchronously after main media file completed
                        if (m.type === MediaType.IMAGE || m.type === MediaType.LIVE_PHOTO || m.type === MediaType.VIDEO) {
                            try {
                                await JobManager.createTask({
                                    type: AsyncTaskType.COVER_BATCH,
                                    libraryId: m.library_id,
                                    inputSnapshot: {
                                        source_type: "MANUAL",
                                        media_ids: [m.id],
                                    },
                                });
                            } catch (coverErr) {
                                console.error(`[COVER_SERVICE] Failed to schedule cover job for media ${m.id}:`, coverErr);
                            }
                        }
                    } else {
                        await db
                            .update(Media)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: completionError ?? "Some files failed to process",
                                update_time: Temporal.Now.instant(),
                            })
                            .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                        if (m.post_id) {
                            await db
                                .update(Post)
                                .set({
                                    sync_status: SyncStatus.FAILED,
                                    last_error: `Media item ${m.id} failed to process: ${completionError ?? "Some files failed to process"}`,
                                    update_time: Temporal.Now.instant(),
                                })
                                .where(and(eq(Post.id, m.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
                        }
                    }
                } catch (e) {
                    if (lockSignal.aborted) throw e;
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    await db
                        .update(Media)
                        .set({ sync_status: SyncStatus.FAILED, last_error: errorMsg, update_time: Temporal.Now.instant() })
                        .where(and(eq(Media.id, m.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                    if (m.post_id) {
                        await db
                            .update(Post)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: `Media item ${m.id} failed to process: ${errorMsg}`,
                                update_time: Temporal.Now.instant(),
                            })
                            .where(and(eq(Post.id, m.post_id), eq(Post.delete_status, DeleteStatus.ACTIVE)));
                    }

                    throw e; // Re-throw to trigger upstream retry
                }
            },
            { ttl: 300, signal },
        ); // 5 minutes TTL, auto-renews every 2.5 minutes!
    },

    /**
     * Step 3: Process author avatar
     */
    async processAvatar(authorId: string, avatarUrl: string, signal?: AbortSignal) {
        const lockKey = `lock:avatar:${authorId}`;

        await withLock(
            lockKey,
            async (lockSignal) => {
                lockSignal.throwIfAborted();
                const authorData = await db.select().from(Author).where(eq(Author.id, authorId));
                const currentAuthor = authorData[0];

                if (currentAuthor && !currentAuthor.avatar_file_id) {
                    const avatarResponse = await downloadStream(avatarUrl, { signal: lockSignal });
                    if (avatarResponse && avatarResponse.body) {
                        lockSignal.throwIfAborted();
                        const avatarContentType = avatarResponse.headers.get("Content-Type");
                        const avatarContentLength = avatarResponse.headers.get("Content-Length");
                        const ext = getExtensionFromContentType(avatarContentType, avatarUrl);
                        const path = `v2/a/${authorId.slice(-2)}/${authorId}/original.${ext}`;

                        await uploadToS3(
                            path,
                            avatarResponse.body,
                            avatarContentType || "application/octet-stream",
                            env.S3_BUCKET,
                            avatarContentLength ? parseInt(avatarContentLength) : undefined,
                            lockSignal,
                        );
                        lockSignal.throwIfAborted();

                        const fileResults = await db
                            .insert(File)
                            .values({
                                path: path,
                                mime_type: avatarContentType || "application/octet-stream",
                                extension: ext,
                                bucket: env.S3_BUCKET,
                            })
                            .onConflictDoUpdate({
                                target: File.path,
                                set: {
                                    mime_type: avatarContentType || "application/octet-stream",
                                    extension: ext,
                                    delete_status: DeleteStatus.ACTIVE,
                                    delete_time: null,
                                },
                            })
                            .returning({ id: File.id });

                        await db.update(Author).set({ avatar_file_id: fileResults[0].id }).where(eq(Author.id, authorId));
                    }
                }
            },
            { ttl: 120, signal },
        ); // 2 minutes TTL, auto-renews every 1 minute
    },

    /**
     * Final Step: Update post status to COMPLETED
     */
    async finalizePost(postId: string) {
        await db
            .update(Post)
            .set({
                sync_status: SyncStatus.COMPLETED,
                last_error: null,
            })
            .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE)));
    },

    /**
     * Mark all posts associated with a workflow run as failed
     */
    async markPostAsFailed(workflowRunId: string, errorMsg: string) {
        await db
            .update(Post)
            .set({
                sync_status: SyncStatus.FAILED,
                last_error: errorMsg,
            })
            .where(and(eq(Post.workflow_run_id, workflowRunId), eq(Post.delete_status, DeleteStatus.ACTIVE)));
    },

    /**
     * Retry sync for failed posts/media by resetting states and re-enqueueing POST_PROCESS tasks.
     */
    async retrySync(options: { postIds?: string[]; mediaIds?: string[] }) {
        const resolvedPostIds = new Set<string>(options.postIds || []);
        const requestedMediaIds = new Set(options.mediaIds || []);

        // Resolve media ids to post ids and retain independent media for direct retry.
        const requestedMedia =
            requestedMediaIds.size > 0
                ? await db
                      .select({ id: Media.id, post_id: Media.post_id, library_id: Media.library_id })
                      .from(Media)
                      .where(and(inArray(Media.id, [...requestedMediaIds]), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                : [];
        for (const media of requestedMedia) {
            if (media.post_id) resolvedPostIds.add(media.post_id);
        }

        const standaloneMedia = requestedMedia.filter((media) => media.post_id === null);
        const postIds = Array.from(resolvedPostIds);
        const posts =
            postIds.length > 0
                ? await db
                      .select()
                      .from(Post)
                      .where(and(inArray(Post.id, postIds), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                : [];

        let requeuedCount = 0;

        for (const post of posts) {
            const customWorkflowRunId = crypto.randomUUID();

            await db.transaction(async (tx) => {
                const postMedia = await tx
                    .select()
                    .from(Media)
                    .where(and(eq(Media.post_id, post.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                const mediaIds = postMedia.map((media) => media.id);

                if (mediaIds.length > 0) {
                    await tx
                        .update(Track)
                        .set({
                            sync_status: SyncStatus.PENDING,
                            last_error: null,
                            update_time: Temporal.Now.instant(),
                        })
                        .where(and(inArray(Track.media_id, mediaIds), eq(Track.sync_status, SyncStatus.FAILED)));

                    await tx
                        .update(Media)
                        .set({
                            sync_status: SyncStatus.PENDING,
                            last_error: null,
                            update_time: Temporal.Now.instant(),
                        })
                        .where(and(eq(Media.post_id, post.id), eq(Media.sync_status, SyncStatus.FAILED)));
                }

                await tx
                    .update(Post)
                    .set({
                        sync_status: SyncStatus.IN_PROGRESS,
                        workflow_run_id: customWorkflowRunId,
                        last_error: null,
                        update_time: Temporal.Now.instant(),
                    })
                    .where(eq(Post.id, post.id));

                const unitSpecs = postMedia.map((media) => ({
                    unitKey: `media:${media.id}`,
                    kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                    subjectType: AsyncSubjectType.MEDIA,
                    subjectId: media.id,
                    inputSnapshot: { post_id: post.id, media_id: media.id },
                }));

                await JobManager.enqueueTaskWithUnits(
                    {
                        type: AsyncTaskType.POST_PROCESS,
                        libraryId: post.library_id,
                        ownerId: null,
                        inputSnapshot: { post_id: post.id },
                        idempotencyKey: `post_process:${post.id}:${customWorkflowRunId}`,
                    },
                    unitSpecs,
                    tx,
                );
            });

            requeuedCount++;
        }

        for (const media of standaloneMedia) {
            const customWorkflowRunId = crypto.randomUUID();

            await db.transaction(async (tx) => {
                const mediaRows = await tx
                    .select({ id: Media.id })
                    .from(Media)
                    .where(and(eq(Media.id, media.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));
                if (mediaRows.length === 0) return;

                await tx
                    .update(Track)
                    .set({
                        sync_status: SyncStatus.PENDING,
                        last_error: null,
                        update_time: Temporal.Now.instant(),
                    })
                    .where(and(eq(Track.media_id, media.id), eq(Track.sync_status, SyncStatus.FAILED)));

                await tx
                    .update(Media)
                    .set({
                        sync_status: SyncStatus.PENDING,
                        last_error: null,
                        update_time: Temporal.Now.instant(),
                    })
                    .where(and(eq(Media.id, media.id), eq(Media.sync_status, SyncStatus.FAILED)));

                await JobManager.enqueueTaskWithUnits(
                    {
                        type: AsyncTaskType.POST_PROCESS,
                        libraryId: media.library_id,
                        ownerId: null,
                        inputSnapshot: { media_ids: [media.id], workflow_run_id: customWorkflowRunId },
                        idempotencyKey: `media_process:${media.id}:${customWorkflowRunId}`,
                    },
                    [
                        {
                            unitKey: `media:${media.id}`,
                            kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
                            subjectType: AsyncSubjectType.MEDIA,
                            subjectId: media.id,
                            inputSnapshot: { media_id: media.id },
                        },
                    ],
                    tx,
                );
            });

            requeuedCount++;
        }

        if (requeuedCount === 0) return { count: 0 };

        jobRunner.wake();
        return { count: requeuedCount };
    },

    /**
     * Sweep tasks stuck in IN_PROGRESS for longer than thresholdMinutes.
     */
    async sweepStuckTasks(thresholdMinutes: number) {
        const threshold = Temporal.Now.instant().subtract({ minutes: thresholdMinutes });

        // Find stuck posts
        const stuckPosts = await db
            .select()
            .from(Post)
            .where(
                and(
                    eq(Post.sync_status, SyncStatus.IN_PROGRESS),
                    or(
                        and(isNotNull(Post.update_time), lt(Post.update_time, threshold)),
                        and(isNull(Post.update_time), lt(Post.create_time, threshold)),
                    ),
                ),
            );

        let sweptCount = 0;
        if (stuckPosts.length > 0) {
            const stuckPostIds = stuckPosts.map((p) => p.id);

            await db.transaction(async (tx) => {
                // 1. Update stuck posts
                await tx
                    .update(Post)
                    .set({
                        sync_status: SyncStatus.FAILED,
                        last_error: `Sync timed out (stuck in IN_PROGRESS for more than ${thresholdMinutes} minutes)`,
                        update_time: Temporal.Now.instant(),
                    })
                    .where(inArray(Post.id, stuckPostIds));

                // 2. Find and update stuck media under these posts
                await tx
                    .update(Media)
                    .set({
                        sync_status: SyncStatus.FAILED,
                        last_error: "Post sync timed out",
                        update_time: Temporal.Now.instant(),
                    })
                    .where(
                        and(inArray(Media.post_id, stuckPostIds), inArray(Media.sync_status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS])),
                    );

                // 3. Find and update stuck tracks under these media items
                const mediaItems = await tx.select({ id: Media.id }).from(Media).where(inArray(Media.post_id, stuckPostIds));

                const mediaIds = mediaItems.map((m) => m.id);
                if (mediaIds.length > 0) {
                    await tx
                        .update(Track)
                        .set({
                            sync_status: SyncStatus.FAILED,
                            last_error: "Post sync timed out",
                            update_time: Temporal.Now.instant(),
                        })
                        .where(
                            and(
                                inArray(Track.media_id, mediaIds),
                                inArray(Track.sync_status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS]),
                            ),
                        );
                }
            });

            sweptCount = stuckPostIds.length;
        }

        const stuckStandaloneMedia = await db
            .select({ id: Media.id })
            .from(Media)
            .where(
                and(
                    isNull(Media.post_id),
                    eq(Media.sync_status, SyncStatus.IN_PROGRESS),
                    or(
                        and(isNotNull(Media.update_time), lt(Media.update_time, threshold)),
                        and(isNull(Media.update_time), lt(Media.create_time, threshold)),
                    ),
                ),
            );

        if (stuckStandaloneMedia.length > 0) {
            const mediaIds = stuckStandaloneMedia.map((media) => media.id);
            await db.transaction(async (tx) => {
                await tx
                    .update(Media)
                    .set({
                        sync_status: SyncStatus.FAILED,
                        last_error: "Independent media sync timed out",
                        update_time: Temporal.Now.instant(),
                    })
                    .where(inArray(Media.id, mediaIds));

                await tx
                    .update(Track)
                    .set({
                        sync_status: SyncStatus.FAILED,
                        last_error: "Independent media sync timed out",
                        update_time: Temporal.Now.instant(),
                    })
                    .where(
                        and(inArray(Track.media_id, mediaIds), inArray(Track.sync_status, [SyncStatus.PENDING, SyncStatus.IN_PROGRESS])),
                    );
            });

            sweptCount += stuckStandaloneMedia.length;
        }

        return { sweptCount };
    },

    /**
     * Copy author avatar and thumb files asynchronously
     */
    async copyAuthorAvatar(sourceAuthorId: string, targetAuthorId: string, signal?: AbortSignal) {
        const lockKey = `lock:avatar-copy:${targetAuthorId}`;

        await withLock(
            lockKey,
            async (lockSignal) => {
                lockSignal.throwIfAborted();
                // 1. Fetch target author and check if avatar is already set
                const targetAuthors = await db.select().from(Author).where(eq(Author.id, targetAuthorId)).limit(1);
                const targetAuthor = targetAuthors[0];
                if (!targetAuthor) {
                    throw new Error(`Target author ${targetAuthorId} not found`);
                }

                // If target author already has an avatar_file_id, skip to prevent overwriting
                if (targetAuthor.avatar_file_id) {
                    return;
                }

                // 2. Fetch source author and its avatar files
                const sourceAuthors = await db.select().from(Author).where(eq(Author.id, sourceAuthorId)).limit(1);
                const sourceAuthor = sourceAuthors[0];
                if (!sourceAuthor) {
                    throw new Error(`Source author ${sourceAuthorId} not found`);
                }

                const fileIds = [sourceAuthor.avatar_file_id, sourceAuthor.avatar_thumb_file_id].filter((id): id is string => !!id);
                if (fileIds.length === 0) {
                    return;
                }

                const files = await db.select().from(File).where(inArray(File.id, fileIds));

                const copyFile = async (sourceFileId: string, isThumb: boolean) => {
                    lockSignal.throwIfAborted();
                    const sourceFile = files.find((f) => f.id === sourceFileId);
                    if (!sourceFile) return null;

                    // Deterministic target path
                    const prefix = isThumb ? "thumb" : "original";
                    const targetPath = `v2/a/${targetAuthorId.slice(-2)}/${targetAuthorId}/${prefix}.${sourceFile.extension}`;

                    // Perform S3 copy
                    try {
                        await s3.copy(sourceFile.path, targetPath, { bucket: sourceFile.bucket, signal: lockSignal });
                    } catch (s3Err: any) {
                        if (lockSignal.aborted) throw s3Err;
                        console.error(`S3 copy error from ${sourceFile.path} to ${targetPath}:`, s3Err);
                        const exists = await s3.exists(targetPath, { bucket: sourceFile.bucket, signal: lockSignal });
                        if (!exists) {
                            throw s3Err;
                        }
                    }
                    lockSignal.throwIfAborted();

                    // Insert or update File record in DB
                    const fileResults = await db
                        .insert(File)
                        .values({
                            path: targetPath,
                            mime_type: sourceFile.mime_type,
                            extension: sourceFile.extension,
                            bucket: sourceFile.bucket,
                            size: sourceFile.size,
                            hash: sourceFile.hash,
                        })
                        .onConflictDoUpdate({
                            target: File.path,
                            set: {
                                mime_type: sourceFile.mime_type,
                                extension: sourceFile.extension,
                                delete_status: DeleteStatus.ACTIVE,
                                delete_time: null,
                            },
                        })
                        .returning({ id: File.id });

                    return fileResults[0]?.id || null;
                };

                let targetAvatarFileId: string | null = null;
                let targetThumbFileId: string | null = null;

                if (sourceAuthor.avatar_file_id) {
                    targetAvatarFileId = await copyFile(sourceAuthor.avatar_file_id, false);
                }
                if (sourceAuthor.avatar_thumb_file_id) {
                    targetThumbFileId = await copyFile(sourceAuthor.avatar_thumb_file_id, true);
                }

                // Update target author in database
                lockSignal.throwIfAborted();
                await db
                    .update(Author)
                    .set({
                        avatar_file_id: targetAvatarFileId || undefined,
                        avatar_thumb_file_id: targetThumbFileId || undefined,
                    })
                    .where(eq(Author.id, targetAuthorId));
            },
            { ttl: 120, signal },
        );
    },
};
