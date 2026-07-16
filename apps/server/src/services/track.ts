import { and, eq, not, inArray } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import { DeleteStatus, File, Track, SyncStatus, Media, Post, TrackType, TrackPurpose } from "@/db/schema";
import { nowDbTimestamp } from "@/lib/utils/time";
import { generateDeterministicVariantKey } from "@/lib/utils/track";
import { Quality } from "@/lib/types";

export interface FileData {
    path: string;
    bucket: string;
    mime_type: string;
    extension: string;
    size: number;
    width?: number | null;
    height?: number | null;
    duration?: number | null;
}

export const TrackService = {
    async listTracks(mediaId: string) {
        return db
            .select({
                track: Track,
                file: File,
            })
            .from(Track)
            .leftJoin(File, eq(Track.file_id, File.id))
            .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));
    },

    async upsertTrack(
        mediaId: string,
        trackInfo: {
            type: TrackType;
            purpose: TrackPurpose;
            quality: Quality;
            priority: number;
            source_url?: string;
            metadata?: any;
            variant_key?: string;
            is_default?: boolean;
            display_name?: string;
            language?: string | null;
            codec?: string | null;
            is_stale?: boolean;
            source_track_id?: string | null;
        },
        fileDataOrId: FileData | string,
        tx: Transaction,
    ) {
        const now = nowDbTimestamp();

        // 1. Resolve or insert physical File record
        let fileRecord: any;
        if (typeof fileDataOrId === "string") {
            const [existingFile] = await tx.select().from(File).where(eq(File.id, fileDataOrId)).limit(1);
            if (!existingFile) {
                throw new Error(`File ${fileDataOrId} not found`);
            }
            fileRecord = existingFile;
        } else {
            const [newFile] = await tx
                .insert(File)
                .values({
                    path: fileDataOrId.path,
                    bucket: fileDataOrId.bucket,
                    mime_type: fileDataOrId.mime_type,
                    extension: fileDataOrId.extension,
                    size: fileDataOrId.size,
                    width: fileDataOrId.width || null,
                    height: fileDataOrId.height || null,
                    duration: fileDataOrId.duration ? Math.round(fileDataOrId.duration) : null,
                    delete_status: DeleteStatus.ACTIVE,
                })
                .returning();
            fileRecord = newFile;
        }

        const variant_key =
            trackInfo.variant_key ??
            generateDeterministicVariantKey(
                {
                    type: trackInfo.type,
                    purpose: trackInfo.purpose,
                    quality: trackInfo.quality,
                    priority: trackInfo.priority,
                    metadata: trackInfo.metadata,
                    language: trackInfo.language,
                    codec: trackInfo.codec,
                },
                fileRecord,
            );

        // 2. Check if a track already exists with the same (media_id, type, purpose, variant_key)
        const [existingTrack] = await tx
            .select()
            .from(Track)
            .where(
                and(
                    eq(Track.media_id, mediaId),
                    eq(Track.type, trackInfo.type),
                    eq(Track.purpose, trackInfo.purpose),
                    eq(Track.variant_key, variant_key),
                    eq(Track.delete_status, DeleteStatus.ACTIVE),
                ),
            );

        const is_default = trackInfo.is_default ?? trackInfo.priority === 0;
        if (is_default) {
            const unsetFilters = [
                eq(Track.media_id, mediaId),
                eq(Track.type, trackInfo.type),
                eq(Track.purpose, trackInfo.purpose),
                eq(Track.delete_status, DeleteStatus.ACTIVE),
            ];
            if (existingTrack) {
                unsetFilters.push(not(eq(Track.id, existingTrack.id)));
            }
            await tx
                .update(Track)
                .set({
                    is_default: false,
                    update_time: now,
                })
                .where(and(...unsetFilters));
        }

        let oldFileId: string | null = null;
        let trackId: string;

        const extractedLang = trackInfo.language ?? trackInfo.metadata?.language ?? null;
        const extractedCodec = trackInfo.codec ?? trackInfo.metadata?.codecs ?? null;

        if (existingTrack) {
            // Keep track of the old file to soft-delete it later
            oldFileId = existingTrack.file_id;
            trackId = existingTrack.id;

            // Merge and update metadata
            const mergedMetadata = {
                ...(existingTrack.metadata || {}),
                ...(trackInfo.metadata || {}),
                width: fileRecord.width ?? existingTrack.metadata?.width,
                height: fileRecord.height ?? existingTrack.metadata?.height,
                duration: fileRecord.duration ? Math.round(fileRecord.duration) : existingTrack.metadata?.duration,
            };

            await tx
                .update(Track)
                .set({
                    file_id: fileRecord.id,
                    is_generated: false, // User took over
                    is_original: true,
                    source_url: trackInfo.source_url ?? existingTrack.source_url,
                    metadata: mergedMetadata,
                    variant_key,
                    is_default,
                    display_name: trackInfo.display_name ?? existingTrack.display_name,
                    language: extractedLang,
                    codec: extractedCodec,
                    is_stale: false,
                    sync_status: SyncStatus.COMPLETED,
                    source_track_id: trackInfo.source_track_id !== undefined ? trackInfo.source_track_id : existingTrack.source_track_id,
                    update_time: now,
                })
                .where(eq(Track.id, existingTrack.id));
        } else {
            // Insert new track
            const mergedMetadata = {
                ...(trackInfo.metadata || {}),
                width: fileRecord.width,
                height: fileRecord.height,
                duration: fileRecord.duration ? Math.round(fileRecord.duration) : null,
            };
            const [inserted] = await tx
                .insert(Track)
                .values({
                    media_id: mediaId,
                    file_id: fileRecord.id,
                    type: trackInfo.type,
                    purpose: trackInfo.purpose,
                    quality: trackInfo.quality,
                    priority: trackInfo.priority,
                    is_original: true,
                    is_generated: false,
                    source_url: trackInfo.source_url || "",
                    metadata: mergedMetadata,
                    variant_key,
                    is_default,
                    display_name: trackInfo.display_name,
                    language: extractedLang,
                    codec: extractedCodec,
                    is_stale: false,
                    sync_status: SyncStatus.COMPLETED,
                    source_track_id: trackInfo.source_track_id || null,
                    delete_status: DeleteStatus.ACTIVE,
                })
                .returning();
            trackId = inserted.id;
        }

        // 3. Mark dependent tracks as stale if the source track's content has changed
        if (existingTrack) {
            const dependentTracks = await tx
                .select()
                .from(Track)
                .where(
                    and(
                        eq(Track.media_id, mediaId),
                        eq(Track.source_track_id, existingTrack.id),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                    ),
                );

            for (const t of dependentTracks) {
                await tx
                    .update(Track)
                    .set({
                        is_stale: true,
                        update_time: now,
                    })
                    .where(eq(Track.id, t.id));
            }
        }

        // 4. Soft-delete old File
        if (oldFileId) {
            await tx
                .update(File)
                .set({
                    delete_status: DeleteStatus.DELETED,
                    delete_time: now,
                })
                .where(eq(File.id, oldFileId));
        }

        // Cascade complete status update
        if (trackInfo.purpose === "CONTENT" && is_default) {
            await tx
                .update(Media)
                .set({
                    sync_status: SyncStatus.COMPLETED,
                    update_time: now,
                })
                .where(eq(Media.id, mediaId));

            const [mediaRow] = await tx.select({ post_id: Media.post_id }).from(Media).where(eq(Media.id, mediaId)).limit(1);

            if (mediaRow?.post_id) {
                const postId = mediaRow.post_id;
                const activeMedias = await tx
                    .select({ id: Media.id, sync_status: Media.sync_status })
                    .from(Media)
                    .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

                const allCompleted = activeMedias.every((m: { id: string; sync_status: string | null }) =>
                    m.id === mediaId ? true : m.sync_status === SyncStatus.COMPLETED,
                );
                if (allCompleted) {
                    await tx
                        .update(Post)
                        .set({
                            sync_status: SyncStatus.COMPLETED,
                            update_time: now,
                        })
                        .where(eq(Post.id, postId));
                }
            }
        }

        return { trackId, fileId: fileRecord.id };
    },

    async replaceFile(mediaId: string, trackId: string, fileData: FileData) {
        return db.transaction(async (tx) => {
            const now = nowDbTimestamp();

            // 1. Fetch the target Track
            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found");
            }

            // 2. Insert physical File record
            const [newFile] = await tx
                .insert(File)
                .values({
                    path: fileData.path,
                    bucket: fileData.bucket,
                    mime_type: fileData.mime_type,
                    extension: fileData.extension,
                    size: fileData.size,
                    width: fileData.width || null,
                    height: fileData.height || null,
                    duration: fileData.duration ? Math.round(fileData.duration) : null,
                    delete_status: DeleteStatus.ACTIVE,
                })
                .returning();

            const oldFileId = trackRecord.file_id;

            // Merge metadata with new file dimension fields
            const mergedMetadata = {
                ...(trackRecord.metadata || {}),
                width: fileData.width ?? trackRecord.metadata?.width,
                height: fileData.height ?? trackRecord.metadata?.height,
                duration: fileData.duration ? Math.round(fileData.duration) : trackRecord.metadata?.duration,
            };

            // 3. Update the Track record
            await tx
                .update(Track)
                .set({
                    file_id: newFile.id,
                    is_stale: false,
                    is_generated: false,
                    is_original: true,
                    metadata: mergedMetadata,
                    update_time: now,
                })
                .where(eq(Track.id, trackId));

            // 4. Mark dependent tracks as stale if the updated track has dependents
            const dependentTracks = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.media_id, mediaId), eq(Track.source_track_id, trackId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            for (const t of dependentTracks) {
                await tx
                    .update(Track)
                    .set({
                        is_stale: true,
                        update_time: now,
                    })
                    .where(eq(Track.id, t.id));
            }

            // 5. Soft-delete old File
            if (oldFileId) {
                await tx
                    .update(File)
                    .set({
                        delete_status: DeleteStatus.DELETED,
                        delete_time: now,
                    })
                    .where(eq(File.id, oldFileId));
            }

            return { trackId, fileId: newFile.id };
        });
    },

    async deleteTrack(mediaId: string, trackId: string) {
        return db.transaction(async (tx) => {
            const now = nowDbTimestamp();

            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found or already deleted");
            }

            // Soft-delete the track
            await tx
                .update(Track)
                .set({
                    delete_status: DeleteStatus.DELETED,
                    delete_time: now,
                    update_time: now,
                })
                .where(eq(Track.id, trackId));

            // Soft-delete the corresponding file
            if (trackRecord.file_id) {
                await tx
                    .update(File)
                    .set({
                        delete_status: DeleteStatus.DELETED,
                        delete_time: now,
                    })
                    .where(eq(File.id, trackRecord.file_id));
            }

            return { success: true };
        });
    },

    async updateTrackMetadata(
        mediaId: string,
        trackId: string,
        updates: {
            priority?: number;
            quality?: any;
            display_name?: string | null;
            variant_key?: string;
            is_default?: boolean;
            language?: string | null;
            codec?: string | null;
            is_stale?: boolean;
            metadata?: any;
            source_track_id?: string | null;
        },
    ) {
        return db.transaction(async (tx) => {
            const now = nowDbTimestamp();

            // 1. Fetch current track
            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found");
            }

            const setParams: any = {
                update_time: now,
            };

            if (updates.priority !== undefined) setParams.priority = updates.priority;
            if (updates.quality !== undefined) setParams.quality = updates.quality;
            if (updates.display_name !== undefined) setParams.display_name = updates.display_name;
            if (updates.variant_key !== undefined) setParams.variant_key = updates.variant_key;
            if (updates.is_default !== undefined) setParams.is_default = updates.is_default;
            if (updates.language !== undefined) setParams.language = updates.language;
            if (updates.codec !== undefined) setParams.codec = updates.codec;
            if (updates.is_stale !== undefined) setParams.is_stale = updates.is_stale;
            if (updates.source_track_id !== undefined) setParams.source_track_id = updates.source_track_id;

            if (updates.metadata !== undefined) {
                setParams.metadata = {
                    ...(trackRecord.metadata || {}),
                    ...updates.metadata,
                };
            }

            // 2. If toggling is_default to true, unset others
            if (updates.is_default === true) {
                await tx
                    .update(Track)
                    .set({
                        is_default: false,
                        update_time: now,
                    })
                    .where(
                        and(
                            eq(Track.media_id, mediaId),
                            eq(Track.type, trackRecord.type),
                            eq(Track.purpose, trackRecord.purpose),
                            not(eq(Track.id, trackId)),
                            eq(Track.delete_status, DeleteStatus.ACTIVE),
                        ),
                    );
            }

            const [updated] = await tx.update(Track).set(setParams).where(eq(Track.id, trackId)).returning();

            return updated;
        });
    },
};
