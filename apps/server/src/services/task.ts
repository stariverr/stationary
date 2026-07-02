import { db } from "@/global/db";
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
    TrackQuality,
    Tag,
    PostTag,
    MediaTag,
    TagStatus,
    TagSource,
} from "@/db/schema";
import { eq, and, notInArray, inArray, gte, isNull, isNotNull, or, lt } from "drizzle-orm";
import { downloadStream, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";
import { VideoCoverService } from "@/services/video_cover";
import { withLock } from "@/lib/utils/lock";
import { env } from "@/global/env";
import { Client } from "@upstash/workflow";
import type { PostItemData, MediaItemData } from "@/api/task";
import { nowDbTimestamp } from "@/lib/utils/time";
import { Temporal } from "@js-temporal/polyfill";
import { sanitizeTags } from "@/lib/utils/tag_sanitizer";
import { generateDeterministicVariantKey } from "@/lib/utils/track";

function formatVttTime(seconds: number): string {
    const ms = Math.floor((seconds % 1) * 1000)
        .toString()
        .padStart(3, "0");
    const totalSecs = Math.floor(seconds);
    const s = (totalSecs % 60).toString().padStart(2, "0");
    const m = (Math.floor(totalSecs / 60) % 60).toString().padStart(2, "0");
    const h = Math.floor(totalSecs / 3600)
        .toString()
        .padStart(2, "0");
    return `${h}:${m}:${s}.${ms}`;
}

function convertBiliJsonToVtt(jsonText: string): string {
    const data = JSON.parse(jsonText);
    let vtt = "WEBVTT\n\n";
    if (data && Array.isArray(data.body)) {
        for (const [idx, item] of data.body.entries()) {
            const from = formatVttTime(item.from || 0);
            const to = formatVttTime(item.to || 0);
            const content = item.content || "";
            vtt += `${idx + 1}\n${from} --> ${to}\n${content}\n\n`;
        }
    }
    return vtt;
}

async function extractSegmentBase(stream: ReadableStream): Promise<{
    segment_base?: {
        initialization: string;
        index_range: string;
        timescale?: number;
        earliest_presentation_time?: string;
    };
    stream: ReadableStream;
}> {
    const maxHeaderSize = 32768;
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    const reader = stream.getReader();
    let done = false;
    let sidxRange:
        | {
              initialization: string;
              index_range: string;
              timescale?: number;
              earliest_presentation_time?: string;
          }
        | undefined = undefined;

    while (bytesRead < maxHeaderSize) {
        const { value, done: readDone } = await reader.read();
        if (readDone) {
            done = true;
            break;
        }
        if (value) {
            chunks.push(value);
            bytesRead += value.length;
        }
    }

    const headerBuffer = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
        headerBuffer.set(chunk, offset);
        offset += chunk.length;
    }

    offset = 0;
    const view = new DataView(headerBuffer.buffer, headerBuffer.byteOffset, headerBuffer.byteLength);
    while (offset + 8 <= bytesRead) {
        const size = view.getUint32(offset);
        const type = String.fromCharCode(
            headerBuffer[offset + 4],
            headerBuffer[offset + 5],
            headerBuffer[offset + 6],
            headerBuffer[offset + 7],
        );

        if (type === "sidx") {
            const version = view.getUint8(offset + 8);
            const timescale = view.getUint32(offset + 16);
            let earliestPresentationTime = 0n;
            if (version === 0) {
                earliestPresentationTime = BigInt(view.getUint32(offset + 20));
            } else {
                earliestPresentationTime = view.getBigUint64(offset + 20);
            }
            sidxRange = {
                initialization: `0-${offset - 1}`,
                index_range: `${offset}-${offset + size - 1}`,
                timescale,
                earliest_presentation_time: earliestPresentationTime.toString(),
            };
            break;
        }

        if (size === 0) {
            break;
        }
        if (size === 1) {
            if (offset + 16 > bytesRead) break;
            const sizeLarge = view.getBigUint64(offset + 8);
            offset += Number(sizeLarge);
        } else {
            offset += size;
        }
    }

    const reconstructedStream = new ReadableStream({
        async start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }
            if (done) {
                controller.close();
                return;
            }
            try {
                while (true) {
                    const { value, done: readDone } = await reader.read();
                    if (readDone) {
                        controller.close();
                        break;
                    }
                    if (value) {
                        controller.enqueue(value);
                    }
                }
            } catch (err) {
                controller.error(err);
            } finally {
                reader.releaseLock();
            }
        },
    });

    return {
        segment_base: sidxRange,
        stream: reconstructedStream,
    };
}

async function syncEntityTags(
    tx: any,
    libraryId: string,
    entityType: "post" | "media",
    entityId: string,
    rawTags: string[],
    source: TagSource,
    sourceField: string,
) {
    const sanitized = sanitizeTags(rawTags);
    if (sanitized.length === 0) {
        if (entityType === "post") {
            await tx.delete(PostTag).where(eq(PostTag.post_id, entityId));
        } else {
            await tx.delete(MediaTag).where(eq(MediaTag.media_id, entityId));
        }
        return;
    }

    const existingTags = await tx.select().from(Tag).where(eq(Tag.library_id, libraryId));

    // Build unified map of normalized names & aliases pointing to their own tag
    const normalizedLookup = new Map<string, any>();
    for (const t of existingTags) {
        normalizedLookup.set(t.normalized_name, t);
    }

    const targetTagIds: string[] = [];

    for (const item of sanitized) {
        if (normalizedLookup.has(item.normalized)) {
            const matched = normalizedLookup.get(item.normalized);
            if (matched.status === TagStatus.IGNORED) {
                continue;
            }
            targetTagIds.push(matched.id);
        } else {
            const inserted = await tx
                .insert(Tag)
                .values({
                    name: item.name,
                    normalized_name: item.normalized,
                    canonical_tag_id: null,
                    library_id: libraryId,
                    status: TagStatus.CANDIDATE,
                    source: source,
                    source_field: sourceField,
                })
                .returning();
            if (inserted[0]) {
                targetTagIds.push(inserted[0].id);
                // Put the newly created candidate into the lookup map to prevent duplicates in the same batch
                normalizedLookup.set(item.normalized, inserted[0]);
            }
        }
    }

    if (entityType === "post") {
        const existingLinks = await tx.select().from(PostTag).where(eq(PostTag.post_id, entityId));
        const existingTagIds = existingLinks.map((l: any) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await tx.insert(PostTag).values(
                toAdd.map((tagId) => ({
                    post_id: entityId,
                    tag_id: tagId,
                })),
            );
        }
        if (toDelete.length > 0) {
            await tx.delete(PostTag).where(and(eq(PostTag.post_id, entityId), inArray(PostTag.tag_id, toDelete)));
        }
    } else {
        const existingLinks = await tx.select().from(MediaTag).where(eq(MediaTag.media_id, entityId));
        const existingTagIds = existingLinks.map((l: any) => l.tag_id);

        const toAdd = targetTagIds.filter((id: string) => !existingTagIds.includes(id));
        const toDelete = existingTagIds.filter((id: string) => !targetTagIds.includes(id));

        if (toAdd.length > 0) {
            await tx.insert(MediaTag).values(
                toAdd.map((tagId) => ({
                    media_id: entityId,
                    tag_id: tagId,
                })),
            );
        }
        if (toDelete.length > 0) {
            await tx.delete(MediaTag).where(and(eq(MediaTag.media_id, entityId), inArray(MediaTag.tag_id, toDelete)));
        }
    }
}

export const TaskService = {
    /**
     * Step 1: Save metadata to DB (Synchronization & Deduplication)
     */
    async saveMetadata(postData: PostItemData, targetLibraryId: string, workflowRunId: string) {
        // 1. Author logic
        let authorId: string | null = null;
        if (postData.author.external_id && postData.platform) {
            try {
                const results = await db
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
                console.error(e);
            }
        }

        // 2. Post logic
        let postId: string;
        let existingPost = null;

        if (postData.external_id) {
            existingPost = await db.query.Post.findFirst({
                where: {
                    eid: postData.external_id,
                    source: postData.platform,
                },
            });
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
                author_id: authorId,
                media_count: postData.media.length,
                library_id: targetLibraryId,
            };
            if (postData.published_time) postUpdateData.published_time = postData.published_time;

            // Always update post metadata to reflect the latest scraped text/tags
            await db.update(Post).set(postUpdateData).where(eq(Post.id, postId));
        } else {
            // Post not exists, create new one
            const eid = postData.external_id || crypto.randomUUID();
            const postInsertData: typeof Post.$inferInsert = {
                eid: eid,
                source: postData.platform,
                title: postData.title,
                description: postData.description,
                tags: postData.tags,
                author_name: postData.author.name,
                author_external_id: postData.author.external_id || "",
                author_id: authorId,
                published_time: postData.published_time ?? null,
                media_count: postData.media.length,
                library_id: targetLibraryId,
                url: postData.url,
                sync_status: SyncStatus.PENDING,
                last_error: null,
                workflow_run_id: workflowRunId,
            };
            const results = await db.insert(Post).values(postInsertData).returning({ id: Post.id, eid: Post.eid });
            postId = results[0].id;
            if (!postData.external_id) postData.external_id = results[0].eid;
            hasPendingTasks = true;
        }

        // Sync relational tags for post
        await syncEntityTags(db, targetLibraryId, "post", postId, postData.tags || [], TagSource.SCRAPER, "post.tags");

        // 3. Media sync
        const mediaEids: string[] = postData.media.map((m) => m.external_id).filter((eid): eid is string => !!eid);

        let mediaToDelete: any[] = [];
        if (postData.media.length === 0) {
            mediaToDelete = await db
                .select()
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));
        } else if (mediaEids.length > 0) {
            mediaToDelete = await db
                .select()
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE), notInArray(Media.eid, mediaEids)));
        } else {
            mediaToDelete = await db
                .select()
                .from(Media)
                .where(
                    and(
                        eq(Media.post_id, postId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        gte(Media.sort_order, postData.media.length),
                    ),
                );
        }

        if (mediaToDelete.length > 0) {
            const deletedMediaIds = mediaToDelete.map((m) => m.id);
            const deleteTime = nowDbTimestamp();
            await db.transaction(async (tx) => {
                await tx
                    .update(Media)
                    .set({
                        delete_status: DeleteStatus.DELETED,
                        delete_time: deleteTime,
                    })
                    .where(and(inArray(Media.id, deletedMediaIds), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                const mediaFiles = await tx
                    .select({ file_id: Track.file_id })
                    .from(Track)
                    .where(and(inArray(Track.media_id, deletedMediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                const fileIds = mediaFiles.map((mf) => mf.file_id).filter((fid): fid is string => !!fid);

                await tx
                    .update(Track)
                    .set({
                        delete_status: DeleteStatus.DELETED,
                        delete_time: deleteTime,
                    })
                    .where(and(inArray(Track.media_id, deletedMediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));

                if (fileIds.length > 0) {
                    await tx
                        .update(File)
                        .set({
                            delete_status: DeleteStatus.DELETED,
                            delete_time: deleteTime,
                        })
                        .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
                }
            });
            hasPendingTasks = true;
        }

        for (const [index, mediaData] of postData.media.entries()) {
            const incomingPublishedTime = mediaData.published_time;
            const fallbackPublishedTime = incomingPublishedTime ?? postData.published_time;
            const oldMediaList = await db
                .select()
                .from(Media)
                .where(
                    and(
                        eq(Media.post_id, postId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        mediaData.external_id ? eq(Media.eid, mediaData.external_id) : eq(Media.sort_order, index),
                    ),
                );

            const deletedMediaList =
                oldMediaList.length === 0
                    ? await db
                          .select()
                          .from(Media)
                          .where(
                              and(
                                  eq(Media.post_id, postId),
                                  eq(Media.delete_status, DeleteStatus.DELETED),
                                  mediaData.external_id ? eq(Media.eid, mediaData.external_id) : eq(Media.sort_order, index),
                              ),
                          )
                    : [];

            if (deletedMediaList.length > 0) {
                continue;
            }

            let mediaId: string;
            let m = oldMediaList[0];

            // Pre-calculate variant keys for incoming tracks
            const adaptedIncomingTracks = mediaData.tracks.map((track, idx) => {
                const baseKey = generateDeterministicVariantKey(
                    {
                        type: track.type,
                        purpose: track.purpose,
                        quality: track.quality,
                        priority: track.priority,
                        metadata: track.metadata,
                        language: (track.metadata as any)?.language,
                        codec: (track.metadata as any)?.codecs,
                    },
                    null,
                );
                return {
                    ...track,
                    baseKey,
                    index: idx,
                };
            });

            const seenKeys = new Set<string>();
            const tracksWithKeys = adaptedIncomingTracks.map((track) => {
                let finalKey = track.baseKey;
                let counter = 1;
                while (seenKeys.has(`${track.purpose}:${finalKey}`)) {
                    counter++;
                    finalKey = `${track.baseKey}-dup-${counter}`;
                }
                seenKeys.add(`${track.purpose}:${finalKey}`);
                return {
                    ...track,
                    variant_key: finalKey,
                };
            });

            if (!m) {
                // Create new media if not exists
                const mediaInsertData: typeof Media.$inferInsert = {
                    eid: mediaData.external_id || "",
                    post_id: postId,
                    library_id: targetLibraryId,
                    source: postData.platform,
                    title: mediaData.title || "",
                    description: mediaData.description || "",
                    type: mediaData.type,
                    sort_order: index,
                    published_time: fallbackPublishedTime,
                    sync_status: SyncStatus.PENDING,
                };
                const insertedMedia = await db.insert(Media).values(mediaInsertData).returning({ id: Media.id });
                mediaId = insertedMedia[0].id;
                hasPendingTasks = true;
            } else {
                // Update existing media if it exists
                mediaId = m.id;
                const updateData: Partial<typeof Media.$inferInsert> = {
                    sort_order: index,
                    title: mediaData.title || "",
                    description: mediaData.description || "",
                    type: mediaData.type,
                };
                if (incomingPublishedTime || (!m.published_time && fallbackPublishedTime)) {
                    updateData.published_time = incomingPublishedTime ?? fallbackPublishedTime;
                }

                // Fetch existing active tracks to see if any track needs processing
                const activeTracks = await db
                    .select()
                    .from(Track)
                    .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

                let mediaNeedsProcessing = false;

                // Check if any incoming track is new, modified, or pending/failed
                for (const track of tracksWithKeys) {
                    const existing = activeTracks.find(
                        (t) => t.type === track.type && t.purpose === track.purpose && t.variant_key === track.variant_key,
                    );
                    if (!existing) {
                        mediaNeedsProcessing = true;
                        break;
                    }
                    if (
                        existing.source_url !== track.url ||
                        existing.is_original !== track.is_original ||
                        existing.quality !== track.quality ||
                        existing.sync_status === SyncStatus.FAILED ||
                        existing.sync_status === SyncStatus.PENDING ||
                        existing.language !== ((track.metadata as any)?.language || null) ||
                        existing.codec !== ((track.metadata as any)?.codecs || null) ||
                        JSON.stringify(existing.metadata) !== JSON.stringify(track.metadata || {})
                    ) {
                        mediaNeedsProcessing = true;
                        break;
                    }
                }

                // Also check if any existing active tracks are being removed
                if (!mediaNeedsProcessing) {
                    for (const t of activeTracks) {
                        const stillExists = tracksWithKeys.some(
                            (track) => track.type === t.type && track.purpose === t.purpose && track.variant_key === t.variant_key,
                        );
                        if (!stillExists) {
                            mediaNeedsProcessing = true;
                            break;
                        }
                    }
                }

                if (m.sync_status === SyncStatus.FAILED || m.sync_status === SyncStatus.PENDING || mediaNeedsProcessing) {
                    updateData.sync_status = SyncStatus.PENDING;
                    updateData.last_error = null;
                    hasPendingTasks = true;
                }

                if (Object.keys(updateData).length > 0) {
                    await db.update(Media).set(updateData).where(eq(Media.id, m.id));
                }
            }

            // Sync relational tags for media
            await syncEntityTags(db, targetLibraryId, "media", mediaId, mediaData.tags || [], TagSource.SCRAPER, "media.tags");

            // Sync Track records
            const existingTracks = await db.select().from(Track).where(eq(Track.media_id, mediaId));

            const processAffiliatedFile = async (trackInfo: {
                type: TrackType;
                purpose: TrackPurpose;
                is_original: boolean;
                quality: TrackQuality;
                priority: number;
                url: string | null | undefined;
                metadata?: any;
                variant_key: string;
            }) => {
                const existing = existingTracks.find(
                    (t) =>
                        t.type === trackInfo.type &&
                        t.purpose === trackInfo.purpose &&
                        t.variant_key === trackInfo.variant_key &&
                        t.delete_status === DeleteStatus.ACTIVE,
                );
                if (trackInfo.url) {
                    const metadata = trackInfo.metadata || {};
                    const extractedLang = trackInfo.metadata?.language || null;
                    const extractedCodec = trackInfo.metadata?.codecs || null;

                    if (!existing) {
                        await db.insert(Track).values({
                            media_id: mediaId,
                            type: trackInfo.type,
                            purpose: trackInfo.purpose,
                            is_original: trackInfo.is_original,
                            quality: trackInfo.quality,
                            priority: trackInfo.priority,
                            source_url: trackInfo.url,
                            metadata: metadata,
                            sync_status: SyncStatus.PENDING,
                            variant_key: trackInfo.variant_key,
                            is_default: trackInfo.priority === 0,
                            language: extractedLang,
                            codec: extractedCodec,
                            is_stale: false,
                        });
                        hasPendingTasks = true;
                    } else if (
                        existing.source_url !== trackInfo.url ||
                        existing.is_original !== trackInfo.is_original ||
                        existing.quality !== trackInfo.quality ||
                        existing.sync_status === SyncStatus.FAILED ||
                        existing.language !== extractedLang ||
                        existing.codec !== extractedCodec ||
                        JSON.stringify(existing.metadata) !== JSON.stringify(metadata)
                    ) {
                        if (existing.file_id) {
                            await db
                                .update(File)
                                .set({
                                    delete_status: DeleteStatus.DELETED,
                                    delete_time: nowDbTimestamp(),
                                })
                                .where(eq(File.id, existing.file_id));
                        }
                        await db
                            .update(Track)
                            .set({
                                source_url: trackInfo.url,
                                is_original: trackInfo.is_original,
                                quality: trackInfo.quality,
                                priority: trackInfo.priority,
                                metadata: metadata,
                                sync_status: SyncStatus.PENDING,
                                file_id: null,
                                last_error: null,
                                language: extractedLang,
                                codec: extractedCodec,
                            })
                            .where(eq(Track.id, existing.id));
                        hasPendingTasks = true;
                    } else if (existing.sync_status === "PENDING") {
                        hasPendingTasks = true;
                    }
                } else if (existing) {
                    // Do not erase existing cover files if url is null/undefined
                    if (trackInfo.purpose === TrackPurpose.COVER) {
                        return;
                    }
                    await db
                        .update(Track)
                        .set({
                            source_url: null,
                            file_id: null,
                            sync_status: SyncStatus.COMPLETED,
                            last_error: null,
                        })
                        .where(eq(Track.id, existing.id));
                }
            };

            const processedTrackKeys = new Set<string>();

            // Process all tracks in a unified loop
            for (const track of tracksWithKeys) {
                processedTrackKeys.add(track.variant_key);
                await processAffiliatedFile(track);
            }

            // Clean up obsolete Track records across all partitions
            for (const t of existingTracks) {
                if (t.delete_status === DeleteStatus.ACTIVE && !processedTrackKeys.has(t.variant_key)) {
                    const deleteTime = nowDbTimestamp();
                    if (t.file_id) {
                        await db
                            .update(File)
                            .set({
                                delete_status: DeleteStatus.DELETED,
                                delete_time: deleteTime,
                            })
                            .where(eq(File.id, t.file_id));
                    }
                    await db
                        .update(Track)
                        .set({
                            delete_status: DeleteStatus.DELETED,
                            delete_time: deleteTime,
                        })
                        .where(eq(Track.id, t.id));
                }
            }
        }

        // 4. Check if Avatar needs processing
        if (authorId && postData.author.avatar_file_url) {
            const author = await db.query.Author.findFirst({
                where: { id: authorId },
            });
            if (author && !author.avatar_file_id) {
                hasPendingTasks = true;
            }
        }

        // 5. Trigger Workflow if needed
        if (hasPendingTasks && existingPost) {
            await db
                .update(Post)
                .set({
                    sync_status: SyncStatus.IN_PROGRESS,
                    workflow_run_id: workflowRunId,
                    last_error: null,
                })
                .where(eq(Post.id, postId));
        }

        return { postId, authorId, skipUpdate: !hasPendingTasks };
    },

    /**
     * Step 2: Process individual media
     */
    async processMedia(postId: string, index: number, mediaData: MediaItemData) {
        const mediaRecords = await db
            .select()
            .from(Media)
            .where(
                and(
                    eq(Media.post_id, postId),
                    eq(Media.delete_status, DeleteStatus.ACTIVE),
                    mediaData.external_id ? eq(Media.eid, mediaData.external_id) : eq(Media.sort_order, index),
                ),
            );
        const m = mediaRecords[0];
        if (!m) return;

        const lockKey = `lock:media:${postId}:${index}`;

        await withLock(
            lockKey,
            async () => {
                try {
                    await db.update(Media).set({ sync_status: SyncStatus.IN_PROGRESS }).where(eq(Media.id, m.id));

                    // Fetch again to ensure we get latest active tracks
                    const tracks = await db
                        .select()
                        .from(Track)
                        .where(and(eq(Track.media_id, m.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));

                    let allCompleted = true;

                    for (const mf of tracks) {
                        // Already completed or no source url, skipping
                        if (mf.sync_status === SyncStatus.COMPLETED || !mf.source_url) continue;

                        // Mark as IN_PROGRESS
                        await db.update(Track).set({ sync_status: SyncStatus.IN_PROGRESS }).where(eq(Track.id, mf.id));

                        try {
                            const response = await downloadStream(mf.source_url);
                            if (response) {
                                let contentType = response.headers.get("Content-Type");
                                let contentLength = response.headers.get("Content-Length");
                                let ext = getExtensionFromContentType(contentType, mf.source_url);
                                let responseBody: ReadableStream | Uint8Array;

                                // Auto-convert Bilibili JSON subtitle to WebVTT
                                if (mf.type === TrackType.SUBTITLE && mf.metadata.format === "json") {
                                    const jsonText = await response.text();
                                    try {
                                        const vttText = convertBiliJsonToVtt(jsonText);
                                        responseBody = new TextEncoder().encode(vttText);
                                        contentType = "text/vtt";
                                        contentLength = responseBody.length.toString();
                                        ext = "vtt";
                                    } catch (err) {
                                        console.error("Failed to convert Bilibili JSON subtitle:", err);
                                        responseBody = new TextEncoder().encode(jsonText);
                                    }
                                } else {
                                    if (!response.body) {
                                        throw new Error("Response body is empty");
                                    }
                                    responseBody = response.body;
                                }

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

                                const path = `v2/p/${postId.slice(-2)}/${postId}/${index}_${prefix}.${ext}`;

                                const S3Data = responseBody;
                                await uploadToS3(
                                    path,
                                    S3Data,
                                    contentType || "application/octet-stream",
                                    env.S3_BUCKET,
                                    contentLength ? parseInt(contentLength) : undefined,
                                );

                                const width = mf.metadata?.width ?? null;
                                const height = mf.metadata?.height ?? null;
                                const duration = mf.metadata?.duration ?? null;
                                const size = contentLength ? parseInt(contentLength) : null;

                                const fileResults = await db
                                    .insert(File)
                                    .values({
                                        path: path,
                                        mime_type: contentType || "application/octet-stream",
                                        extension: ext,
                                        bucket: env.S3_BUCKET,
                                        width: width,
                                        height: height,
                                        duration: duration ? Math.round(duration) : null,
                                        size: size,
                                    })
                                    .onConflictDoUpdate({
                                        target: File.path,
                                        set: {
                                            mime_type: contentType || "application/octet-stream",
                                            extension: ext,
                                            width: width,
                                            height: height,
                                            duration: duration ? Math.round(duration) : null,
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

                                await db
                                    .update(Track)
                                    .set({
                                        file_id: fileResults[0].id,
                                        sync_status: SyncStatus.COMPLETED,
                                        last_error: null,
                                        metadata: updatedMetadata,
                                    })
                                    .where(eq(Track.id, mf.id));
                            }
                        } catch (e) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            await db.update(Track).set({ sync_status: SyncStatus.FAILED, last_error: errorMsg }).where(eq(Track.id, mf.id));
                            allCompleted = false;
                            throw e;
                        }
                    }

                    if (allCompleted) {
                        await db.update(Media).set({ sync_status: SyncStatus.COMPLETED, last_error: null }).where(eq(Media.id, m.id));

                        // Trigger video cover generation asynchronously after main video completed
                        if (m.type === "VIDEO") {
                            try {
                                await VideoCoverService.requestForMedia(m.id);
                            } catch (coverErr) {
                                console.error(`[VIDEO COVER] Failed to schedule cover extraction for media ${m.id}:`, coverErr);
                            }
                        }
                    } else {
                        await db
                            .update(Media)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: "Some files failed to process",
                            })
                            .where(eq(Media.id, m.id));

                        await db
                            .update(Post)
                            .set({
                                sync_status: SyncStatus.FAILED,
                                last_error: `Media item ${m.id} failed to process: Some files failed to process`,
                            })
                            .where(eq(Post.id, postId));
                    }
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    await db.update(Media).set({ sync_status: SyncStatus.FAILED, last_error: errorMsg }).where(eq(Media.id, m.id));

                    await db
                        .update(Post)
                        .set({
                            sync_status: SyncStatus.FAILED,
                            last_error: `Media item ${m.id} failed to process: ${errorMsg}`,
                        })
                        .where(eq(Post.id, postId));

                    throw e; // Re-throw to trigger upstream retry
                }
            },
            { ttl: 300 },
        ); // 5 minutes TTL, auto-renews every 2.5 minutes!
    },

    /**
     * Step 3: Process author avatar
     */
    async processAvatar(authorId: string, avatarUrl: string) {
        const lockKey = `lock:avatar:${authorId}`;

        await withLock(
            lockKey,
            async () => {
                const authorData = await db.select().from(Author).where(eq(Author.id, authorId));
                const currentAuthor = authorData[0];

                if (currentAuthor && !currentAuthor.avatar_file_id) {
                    const avatarResponse = await downloadStream(avatarUrl);
                    if (avatarResponse && avatarResponse.body) {
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
                        );

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
            { ttl: 120 },
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
     * Retry sync for failed posts/media by resetting states and re-triggering the QStash sync workflow.
     */
    async retrySync(options: { postIds?: string[]; mediaIds?: string[]; originUrl: string }) {
        if (!env.QSTASH_TOKEN) {
            throw new Error("QSTASH_TOKEN is not configured");
        }

        const resolvedPostIds = new Set<string>(options.postIds || []);

        // Resolve media ids to post ids
        if (options.mediaIds && options.mediaIds.length > 0) {
            const mediaList = await db.select({ post_id: Media.post_id }).from(Media).where(inArray(Media.id, options.mediaIds));
            for (const m of mediaList) {
                if (m.post_id) {
                    resolvedPostIds.add(m.post_id);
                }
            }
        }

        const postIds = Array.from(resolvedPostIds);
        if (postIds.length === 0) return { count: 0 };

        // Fetch posts
        const posts = await db
            .select()
            .from(Post)
            .where(and(inArray(Post.id, postIds), eq(Post.delete_status, DeleteStatus.ACTIVE)));

        if (posts.length === 0) return { count: 0 };

        const customWorkflowRunId = crypto.randomUUID();
        const postsToProcess: Array<{
            data: PostItemData;
            id: string;
            authorId: string | null;
        }> = [];

        // For each post, prepare payload and reset status
        for (const post of posts) {
            // Reset failed media items and failed media files under this post
            const postMedia = await db
                .select()
                .from(Media)
                .where(and(eq(Media.post_id, post.id), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            const mediaIds = postMedia.map((m) => m.id);

            const postTagsList = await db
                .select({ name: Tag.name })
                .from(PostTag)
                .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                .where(and(eq(PostTag.post_id, post.id), eq(Tag.status, TagStatus.ACTIVE)));
            const postTagNames = postTagsList.map((pt) => pt.name);

            const mediaTagsList =
                mediaIds.length > 0
                    ? await db
                          .select({ media_id: MediaTag.media_id, name: Tag.name })
                          .from(MediaTag)
                          .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
                          .where(and(inArray(MediaTag.media_id, mediaIds), eq(Tag.status, TagStatus.ACTIVE)))
                    : [];

            if (mediaIds.length > 0) {
                // Reset failed tracks to PENDING
                await db
                    .update(Track)
                    .set({
                        sync_status: SyncStatus.PENDING,
                        last_error: null,
                    })
                    .where(and(inArray(Track.media_id, mediaIds), eq(Track.sync_status, SyncStatus.FAILED)));

                // Reset failed media items to PENDING
                await db
                    .update(Media)
                    .set({
                        sync_status: SyncStatus.PENDING,
                        last_error: null,
                    })
                    .where(and(eq(Media.post_id, post.id), eq(Media.sync_status, SyncStatus.FAILED)));
            }

            // Reset post status
            await db
                .update(Post)
                .set({
                    sync_status: SyncStatus.IN_PROGRESS,
                    workflow_run_id: customWorkflowRunId,
                    last_error: null,
                })
                .where(eq(Post.id, post.id));

            const postTracks =
                mediaIds.length > 0
                    ? await db
                          .select()
                          .from(Track)
                          .where(and(inArray(Track.media_id, mediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)))
                    : [];

            const mappedMedia = postMedia.map((m) => {
                let tracks = postTracks
                    .filter((mf) => mf.media_id === m.id)
                    .map((mf) => ({
                        url: mf.source_url || "",
                        type: mf.type,
                        purpose: mf.purpose,
                        is_original: mf.is_original,
                        quality: mf.quality,
                        priority: mf.priority,
                        metadata: mf.metadata || {},
                    }));

                if (tracks.length === 0) {
                    if (m.primary_url) {
                        let primaryType = TrackType.IMAGE;
                        if (m.type === "VIDEO") primaryType = TrackType.VIDEO;
                        else if (m.type === "AUDIO") primaryType = TrackType.AUDIO;
                        tracks.push({
                            url: m.primary_url,
                            type: primaryType,
                            purpose: TrackPurpose.CONTENT,
                            is_original: true,
                            quality: TrackQuality.ORIGINAL,
                            priority: 0,
                            metadata: {},
                        });
                    }
                    if (m.cover_url) {
                        tracks.push({
                            url: m.cover_url,
                            type: TrackType.IMAGE,
                            purpose: TrackPurpose.COVER,
                            is_original: false,
                            quality: TrackQuality.ORIGINAL,
                            priority: 0,
                            metadata: {},
                        });
                    }
                    if (m.alternative_url) {
                        let altType = TrackType.IMAGE;
                        if (m.type === "VIDEO") altType = TrackType.VIDEO;
                        else if (m.type === "AUDIO") altType = TrackType.AUDIO;
                        tracks.push({
                            url: m.alternative_url,
                            type: altType,
                            purpose: TrackPurpose.CONTENT,
                            is_original: true,
                            quality: TrackQuality.MEDIUM,
                            priority: 1,
                            metadata: {},
                        });
                    }
                    if (m.live_photo_url) {
                        tracks.push({
                            url: m.live_photo_url,
                            type: TrackType.VIDEO,
                            purpose: TrackPurpose.CONTENT,
                            is_original: true,
                            quality: TrackQuality.ORIGINAL,
                            priority: 0,
                            metadata: {},
                        });
                    }
                }

                const mediaTagNames = mediaTagsList.filter((mt) => mt.media_id === m.id).map((mt) => mt.name);

                return {
                    external_id: m.eid,
                    title: m.title,
                    description: m.description,
                    type: m.type,
                    tracks,
                    tags: mediaTagNames,
                    published_time: m.published_time ?? undefined,
                };
            });

            postsToProcess.push({
                id: post.id,
                authorId: post.author_id,
                data: {
                    title: post.title,
                    url: post.url ?? undefined,
                    description: post.description,
                    external_id: post.eid,
                    tags: postTagNames,
                    author: {
                        name: post.author_name,
                        external_id: post.author_external_id ?? undefined,
                        avatar_file_url: null,
                    },
                    platform: post.source,
                    media: mappedMedia,
                    published_time: post.published_time ?? undefined,
                },
            });
        }

        const client = new Client({ token: env.QSTASH_TOKEN });
        const workflowUrl = `${options.originUrl.replace(/\/$/, "")}/api/task/workflow`;

        if (postsToProcess.length > 0) {
            await client.trigger({
                url: workflowUrl,
                body: { posts: postsToProcess },
                headers: {
                    "Content-Type": "application/json",
                },
                workflowRunId: customWorkflowRunId,
            });
        }

        return { count: postsToProcess.length };
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

        return { sweptCount };
    },

    /**
     * Copy author avatar and thumb files asynchronously
     */
    async copyAuthorAvatar(sourceAuthorId: string, targetAuthorId: string) {
        const lockKey = `lock:avatar-copy:${targetAuthorId}`;

        await withLock(
            lockKey,
            async () => {
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
                    const sourceFile = files.find((f) => f.id === sourceFileId);
                    if (!sourceFile) return null;

                    // Deterministic target path
                    const prefix = isThumb ? "thumb" : "original";
                    const targetPath = `v2/a/${targetAuthorId.slice(-2)}/${targetAuthorId}/${prefix}.${sourceFile.extension}`;

                    // Perform S3 copy
                    const { s3 } = await import("@/global/s3");
                    try {
                        await s3.copy(sourceFile.path, targetPath, { bucket: sourceFile.bucket });
                    } catch (s3Err: any) {
                        console.error(`S3 copy error from ${sourceFile.path} to ${targetPath}:`, s3Err);
                        const exists = await s3.exists(targetPath, { bucket: sourceFile.bucket });
                        if (!exists) {
                            throw s3Err;
                        }
                    }

                    // Insert or update File record in DB
                    const fileResults = await db
                        .insert(File)
                        .values({
                            path: targetPath,
                            mime_type: sourceFile.mime_type,
                            extension: sourceFile.extension,
                            bucket: sourceFile.bucket,
                            width: sourceFile.width,
                            height: sourceFile.height,
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
                await db
                    .update(Author)
                    .set({
                        avatar_file_id: targetAvatarFileId || undefined,
                        avatar_thumb_file_id: targetThumbFileId || undefined,
                    })
                    .where(eq(Author.id, targetAuthorId));
            },
            { ttl: 120 },
        );
    },
};
