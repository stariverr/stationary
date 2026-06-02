import { db } from "@/global/db";
import {
    Post,
    Media,
    MediaFile,
    Author,
    File,
    Library,
    DeleteStatus,
    SyncStatus,
    MediaFileRole,
} from "@/db/schema";
import { eq, and, notInArray, inArray, gte, isNull, isNotNull } from "drizzle-orm";
import {
    downloadStream,
    downloadMedia,
    getExtensionFromContentType,
    uploadToS3,
} from "@/lib/utils/media";
import { VideoCoverService } from "@/services/video_cover";
import { withLock } from "@/lib/utils/lock";
import { env } from "@/global/env";
import { kv } from "@/global/kv";
import type { PostItemData, MediaItemData } from "@/api/task";
import { nowDbTimestamp } from "@/lib/utils/time";

export const TaskService = {
    /**
     * Step 1: Save metadata to DB (Synchronization & Deduplication)
     */
    async saveMetadata(postData: PostItemData, targetLibraryId: string, workflowRunId: string) {
        // 1. Author logic
        let authorId: string | null = null;
        if (postData.author.external_id && postData.platform) {
            try {
                let author = await db.query.Author.findFirst({
                    where: {
                        eid: postData.author.external_id,
                        platform: postData.platform,
                    },
                });

                if (!author) {
                    const results = await db
                        .insert(Author)
                        .values({
                            eid: postData.author.external_id,
                            nickname: postData.author.name,
                            platform: postData.platform,
                        })
                        .returning();
                    author = results[0];
                } else {
                    if (author.nickname !== postData.author.name) {
                        await db
                            .update(Author)
                            .set({ nickname: postData.author.name })
                            .where(eq(Author.id, author.id));
                    }
                }
                authorId = author.id;
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

        if (
            existingPost &&
            (existingPost.delete_status === "DELETED" || existingPost.recycle_time !== null)
        ) {
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
            const results = await db
                .insert(Post)
                .values(postInsertData)
                .returning({ id: Post.id, eid: Post.eid });
            postId = results[0].id;
            if (!postData.external_id) postData.external_id = results[0].eid;
            hasPendingTasks = true;
        }

        // 3. Media sync
        const mediaEids: string[] = postData.media
            .map((m) => m.external_id)
            .filter((eid): eid is string => !!eid);

        let mediaToDelete: any[] = [];
        if (postData.media.length === 0) {
            mediaToDelete = await db
                .select()
                .from(Media)
                .where(
                    and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)),
                );
        } else if (mediaEids.length > 0) {
            mediaToDelete = await db
                .select()
                .from(Media)
                .where(
                    and(
                        eq(Media.post_id, postId),
                        eq(Media.delete_status, DeleteStatus.ACTIVE),
                        notInArray(Media.eid, mediaEids),
                    ),
                );
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
                    .where(
                        and(
                            inArray(Media.id, deletedMediaIds),
                            eq(Media.delete_status, DeleteStatus.ACTIVE),
                        ),
                    );

                const mediaFiles = await tx
                    .select({ file_id: MediaFile.file_id })
                    .from(MediaFile)
                    .where(
                        and(
                            inArray(MediaFile.media_id, deletedMediaIds),
                            eq(MediaFile.delete_status, DeleteStatus.ACTIVE),
                        ),
                    );
                const fileIds = mediaFiles
                    .map((mf) => mf.file_id)
                    .filter((fid): fid is string => !!fid);

                await tx
                    .update(MediaFile)
                    .set({
                        delete_status: DeleteStatus.DELETED,
                        delete_time: deleteTime,
                    })
                    .where(
                        and(
                            inArray(MediaFile.media_id, deletedMediaIds),
                            eq(MediaFile.delete_status, DeleteStatus.ACTIVE),
                        ),
                    );

                if (fileIds.length > 0) {
                    await tx
                        .update(File)
                        .set({
                            delete_status: DeleteStatus.DELETED,
                            delete_time: deleteTime,
                        })
                        .where(
                            and(
                                inArray(File.id, fileIds),
                                eq(File.delete_status, DeleteStatus.ACTIVE),
                            ),
                        );
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
                        mediaData.external_id
                            ? eq(Media.eid, mediaData.external_id)
                            : eq(Media.sort_order, index),
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
                                  mediaData.external_id
                                      ? eq(Media.eid, mediaData.external_id)
                                      : eq(Media.sort_order, index),
                              ),
                          )
                    : [];

            if (deletedMediaList.length > 0) {
                continue;
            }

            let mediaId: string;
            let m = oldMediaList[0];

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
                    primary_url: mediaData.primary_file_url,
                    alternative_url: mediaData.alternative_file_url || null,
                    live_photo_url: mediaData.live_photo_video_url || null,
                    cover_url: mediaData.cover_file_url || null,
                    published_time: fallbackPublishedTime,
                    sync_status: SyncStatus.PENDING,
                };
                const insertedMedia = await db
                    .insert(Media)
                    .values(mediaInsertData)
                    .returning({ id: Media.id });
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

                let mediaNeedsProcessing = false;

                if (m.primary_url !== mediaData.primary_file_url) {
                    updateData.primary_url = mediaData.primary_file_url;
                    mediaNeedsProcessing = true;
                }
                if (m.alternative_url !== (mediaData.alternative_file_url || null)) {
                    updateData.alternative_url = mediaData.alternative_file_url || null;
                    mediaNeedsProcessing = true;
                }
                if (m.live_photo_url !== (mediaData.live_photo_video_url || null)) {
                    updateData.live_photo_url = mediaData.live_photo_video_url || null;
                    mediaNeedsProcessing = true;
                }
                if (m.cover_url !== (mediaData.cover_file_url || null)) {
                    updateData.cover_url = mediaData.cover_file_url || null;
                    mediaNeedsProcessing = true;
                }

                if (
                    m.sync_status === SyncStatus.FAILED ||
                    m.sync_status === SyncStatus.PENDING ||
                    mediaNeedsProcessing
                ) {
                    updateData.sync_status = SyncStatus.PENDING;
                    updateData.last_error = null;
                    hasPendingTasks = true;
                }

                if (Object.keys(updateData).length > 0) {
                    await db.update(Media).set(updateData).where(eq(Media.id, m.id));
                }
            }

            // Sync MediaFile records
            const existingMediaFiles = await db
                .select()
                .from(MediaFile)
                .where(eq(MediaFile.media_id, mediaId));

            const processAffiliatedFile = async (
                role: MediaFileRole,
                newUrl: string | null | undefined,
            ) => {
                const existing = existingMediaFiles.find((mf) => mf.role === role);
                if (newUrl) {
                    if (!existing) {
                        await db.insert(MediaFile).values({
                            media_id: mediaId,
                            role: role,
                            source_url: newUrl,
                            sync_status: SyncStatus.PENDING,
                        });
                        hasPendingTasks = true;
                    } else if (
                        existing.source_url !== newUrl ||
                        existing.sync_status === SyncStatus.FAILED
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
                            .update(MediaFile)
                            .set({
                                source_url: newUrl,
                                sync_status: SyncStatus.PENDING,
                                file_id: null,
                                last_error: null,
                            })
                            .where(eq(MediaFile.id, existing.id));
                        hasPendingTasks = true;
                    } else if (existing.sync_status === "PENDING") {
                        hasPendingTasks = true;
                    }
                } else if (existing) {
                    // Do not erase existing cover files if newUrl is null/undefined
                    if (role === "COVER") {
                        return;
                    }
                    await db
                        .update(MediaFile)
                        .set({
                            source_url: null,
                            file_id: null,
                            sync_status: SyncStatus.COMPLETED,
                            last_error: null,
                        })
                        .where(eq(MediaFile.id, existing.id));
                }
            };

            await processAffiliatedFile(MediaFileRole.PRIMARY, mediaData.primary_file_url);
            await processAffiliatedFile(MediaFileRole.ALTERNATIVE, mediaData.alternative_file_url);
            await processAffiliatedFile(
                MediaFileRole.LIVE_PHOTO_VIDEO,
                mediaData.live_photo_video_url,
            );
            await processAffiliatedFile(MediaFileRole.COVER, mediaData.cover_file_url);
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
                    mediaData.external_id
                        ? eq(Media.eid, mediaData.external_id)
                        : eq(Media.sort_order, index),
                ),
            );
        const m = mediaRecords[0];
        if (!m) return;

        const lockKey = `lock:media:${postId}:${index}`;

        await withLock(
            lockKey,
            async () => {
                try {
                    await db
                        .update(Media)
                        .set({ sync_status: SyncStatus.IN_PROGRESS })
                        .where(eq(Media.id, m.id));

                    // Fetch again to ensure we get latest
                    const mediaFiles = await db
                        .select()
                        .from(MediaFile)
                        .where(eq(MediaFile.media_id, m.id));

                    let allCompleted = true;

                    for (const mf of mediaFiles) {
                        // Already completed or no source url, skipping
                        if (mf.sync_status === SyncStatus.COMPLETED || !mf.source_url) continue;

                        // Mark as IN_PROGRESS
                        await db
                            .update(MediaFile)
                            .set({ sync_status: SyncStatus.IN_PROGRESS })
                            .where(eq(MediaFile.id, mf.id));

                        try {
                            const response = await downloadStream(mf.source_url);
                            if (response && response.body) {
                                const contentType = response.headers.get("Content-Type");
                                const contentLength = response.headers.get("Content-Length");
                                const ext = getExtensionFromContentType(contentType);

                                let prefix = "";
                                if (mf.role === "PRIMARY") prefix = "file";
                                else if (mf.role === "ALTERNATIVE") prefix = "alt";
                                else if (mf.role === "LIVE_PHOTO_VIDEO") prefix = "live";
                                else if (mf.role === "COVER") prefix = "cover";

                                const path = `v2/p/${postId.slice(-2)}/${postId}/${index}_${prefix}.${ext}`;

                                await uploadToS3(
                                    path,
                                    response.body,
                                    contentType || "application/octet-stream",
                                    env.S3_BUCKET,
                                    contentLength ? parseInt(contentLength) : undefined,
                                );

                                const fileResults = await db
                                    .insert(File)
                                    .values({
                                        path: path,
                                        mime_type: contentType || "application/octet-stream",
                                        extension: ext,
                                        bucket: env.S3_BUCKET,
                                    })
                                    .onConflictDoUpdate({
                                        target: File.path,
                                        set: {
                                            mime_type: contentType || "application/octet-stream",
                                            extension: ext,
                                        },
                                    })
                                    .returning({ id: File.id });

                                await db
                                    .update(MediaFile)
                                    .set({
                                        file_id: fileResults[0].id,
                                        sync_status: SyncStatus.COMPLETED,
                                        last_error: null,
                                    })
                                    .where(eq(MediaFile.id, mf.id));
                            }
                        } catch (e) {
                            const errorMsg = e instanceof Error ? e.message : String(e);
                            await db
                                .update(MediaFile)
                                .set({ sync_status: SyncStatus.FAILED, last_error: errorMsg })
                                .where(eq(MediaFile.id, mf.id));
                            allCompleted = false;
                            throw e;
                        }
                    }

                    if (allCompleted) {
                        await db
                            .update(Media)
                            .set({ sync_status: SyncStatus.COMPLETED, last_error: null })
                            .where(eq(Media.id, m.id));

                        // Trigger video cover generation asynchronously after main video completed
                        if (m.type === "VIDEO") {
                            try {
                                await VideoCoverService.requestForMedia(m.id);
                            } catch (coverErr) {
                                console.error(
                                    `[VIDEO COVER] Failed to schedule cover extraction for media ${m.id}:`,
                                    coverErr,
                                );
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
                    }
                } catch (e) {
                    const errorMsg = e instanceof Error ? e.message : String(e);
                    await db
                        .update(Media)
                        .set({ sync_status: SyncStatus.FAILED, last_error: errorMsg })
                        .where(eq(Media.id, m.id));
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
                        const ext = getExtensionFromContentType(avatarContentType);
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
                                },
                            })
                            .returning({ id: File.id });

                        await db
                            .update(Author)
                            .set({ avatar_file_id: fileResults[0].id })
                            .where(eq(Author.id, authorId));
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
            .where(
                and(
                    eq(Post.workflow_run_id, workflowRunId),
                    eq(Post.delete_status, DeleteStatus.ACTIVE),
                ),
            );
    },
};
