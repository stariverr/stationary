import { and, eq, not } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import {
    DeleteStatus,
    File,
    Track,
    SyncStatus,
    Media,
    Post,
    TrackType,
    TrackPurpose,
    TrackStreamLayout,
    type Stream,
    type TrackMetadata,
} from "@/db/schema";

import { generateDeterministicVariantKey } from "@/lib/utils/track";
import { Quality } from "@/lib/types";
import { Temporal } from "@js-temporal/polyfill";
import { cleanTrackMetadata, deriveTrackFormat } from "@/lib/utils/track-format";
import { DeleteService } from "@/services/delete";
import { MediaService } from "@/services/media";

export interface FileData {
    path: string;
    bucket: string;
    mime_type: string;
    extension: string;
    size: number;
}

export interface UpsertTrackInput {
    type: TrackType;
    purpose: TrackPurpose;
    quality: Quality;
    priority: number;
    source_url?: string;
    metadata?: TrackMetadata | Record<string, unknown>;
    variant_key?: string;
    is_default?: boolean;
    is_primary?: boolean;
    display_name?: string;
    language?: string | null;
    codec?: string | null;
    duration?: number | null;
    width?: number | null;
    height?: number | null;
    bandwidth?: number | null;
    is_stale?: boolean;
    source_track_id?: string | null;
    container?: string | null;
    is_fragmented?: boolean | null;
    stream_layout?: TrackStreamLayout | null;
    has_video?: boolean | null;
    has_audio?: boolean | null;
    streams?: Stream[] | null;
}

export interface UpdateTrackMetadataInput {
    priority?: number;
    quality?: Quality;
    display_name?: string | null;
    variant_key?: string;
    is_default?: boolean;
    is_primary?: boolean;
    language?: string | null;
    codec?: string | null;
    is_stale?: boolean;
    metadata?: Record<string, unknown>;
    source_track_id?: string | null;
    container?: string | null;
    is_fragmented?: boolean | null;
    stream_layout?: TrackStreamLayout | null;
    has_video?: boolean | null;
    has_audio?: boolean | null;
    streams?: Stream[] | null;
}

const asMetadataRecord = (value: unknown): Record<string, any> =>
    typeof value === "object" && value !== null ? { ...(value as Record<string, any>) } : {};

function prepareTrackMetadata(incomingMetadata: unknown) {
    return cleanTrackMetadata(asMetadataRecord(incomingMetadata));
}

function resolveFormatUpdate(
    update: {
        container?: string | null;
        is_fragmented?: boolean | null;
        stream_layout?: TrackStreamLayout | null;
        has_video?: boolean | null;
        has_audio?: boolean | null;
        streams?: Stream[] | null;
    },
    fallback?: typeof Track.$inferSelect,
) {
    return {
        container: update.container !== undefined ? update.container : fallback?.container,
        is_fragmented: update.is_fragmented !== undefined ? update.is_fragmented : fallback?.is_fragmented,
        stream_layout: update.stream_layout !== undefined ? update.stream_layout : fallback?.stream_layout,
        has_video: update.has_video !== undefined ? update.has_video : fallback?.has_video,
        has_audio: update.has_audio !== undefined ? update.has_audio : fallback?.has_audio,
        streams: update.streams !== undefined ? update.streams : fallback?.streams,
    };
}

async function resolveFileRecord(tx: Transaction, fileDataOrId: FileData | string) {
    if (typeof fileDataOrId === "string") {
        const [existingFile] = await tx.select().from(File).where(eq(File.id, fileDataOrId)).limit(1);
        if (!existingFile) {
            throw new Error(`File ${fileDataOrId} not found`);
        }
        return existingFile;
    }

    const [newFile] = await tx
        .insert(File)
        .values({
            path: fileDataOrId.path,
            bucket: fileDataOrId.bucket,
            mime_type: fileDataOrId.mime_type,
            extension: fileDataOrId.extension,
            size: fileDataOrId.size,
            delete_status: DeleteStatus.ACTIVE,
        })
        .returning();
    return newFile;
}

async function unsetOtherDefaults(
    tx: Transaction,
    mediaId: string,
    type: TrackType,
    purpose: TrackPurpose,
    now: Temporal.Instant,
    excludeTrackId?: string,
) {
    const unsetFilters = [
        eq(Track.media_id, mediaId),
        eq(Track.type, type),
        eq(Track.purpose, purpose),
        eq(Track.delete_status, DeleteStatus.ACTIVE),
    ];
    if (excludeTrackId) {
        unsetFilters.push(not(eq(Track.id, excludeTrackId)));
    }
    await tx
        .update(Track)
        .set({ is_default: false, update_time: now })
        .where(and(...unsetFilters));
}

async function unsetOtherPrimaries(tx: Transaction, mediaId: string, now: Temporal.Instant, excludeTrackId?: string) {
    const unsetFilters = [eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)];
    if (excludeTrackId) {
        unsetFilters.push(not(eq(Track.id, excludeTrackId)));
    }
    await tx
        .update(Track)
        .set({ is_primary: false, update_time: now })
        .where(and(...unsetFilters));
}

function extractTrackAttributes(input: UpsertTrackInput, fileRecord: typeof File.$inferSelect, existingTrack?: typeof Track.$inferSelect) {
    const preservesExistingFile = existingTrack ? existingTrack.file_id === fileRecord.id : false;
    const finalMetadata =
        input.metadata !== undefined ? prepareTrackMetadata(input.metadata) : ((existingTrack?.metadata as Record<string, unknown>) ?? {});
    const formatUpdate = resolveFormatUpdate(input, preservesExistingFile ? existingTrack : undefined);

    const format = deriveTrackFormat({
        ...input,
        metadata: finalMetadata,
        ...formatUpdate,
        file: fileRecord,
    });

    const language = input.language !== undefined ? input.language : (existingTrack?.language ?? null);
    const codec = input.codec !== undefined ? input.codec : preservesExistingFile ? (existingTrack?.codec ?? null) : null;
    const duration = input.duration ?? existingTrack?.duration ?? null;
    const width = input.width ?? existingTrack?.width ?? null;
    const height = input.height ?? existingTrack?.height ?? null;
    const bandwidth = input.bandwidth ?? existingTrack?.bandwidth ?? null;

    return {
        metadata: finalMetadata,
        format,
        language,
        codec,
        duration,
        width,
        height,
        bandwidth,
    };
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

    async upsertTrack(mediaId: string, trackInfo: UpsertTrackInput, fileDataOrId: FileData | string, tx: Transaction) {
        const now = Temporal.Now.instant();

        // 1. Resolve or insert physical File record
        const fileRecord = await resolveFileRecord(tx, fileDataOrId);

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
            await unsetOtherDefaults(tx, mediaId, trackInfo.type, trackInfo.purpose, now, existingTrack?.id);
        }

        const is_primary = trackInfo.is_primary ?? (trackInfo.purpose === TrackPurpose.CONTENT && is_default);
        if (is_primary) {
            await unsetOtherPrimaries(tx, mediaId, now, existingTrack?.id);
        }

        // 3. Extract metadata, format, and attributes
        const { metadata, format, language, codec, duration, width, height, bandwidth } = extractTrackAttributes(
            trackInfo,
            fileRecord,
            existingTrack,
        );

        let resultTrack: typeof Track.$inferSelect;
        let oldFileId: string | null = null;

        if (existingTrack) {
            oldFileId = existingTrack.file_id;

            const [updated] = await tx
                .update(Track)
                .set({
                    file_id: fileRecord.id,
                    is_generated: false,
                    is_original: true,
                    source_url: trackInfo.source_url ?? existingTrack.source_url,
                    metadata,
                    variant_key,
                    is_default,
                    is_primary,
                    display_name: trackInfo.display_name ?? existingTrack.display_name,
                    language,
                    codec,
                    duration,
                    width,
                    height,
                    bandwidth,
                    is_stale: false,
                    sync_status: SyncStatus.COMPLETED,
                    source_track_id: trackInfo.source_track_id !== undefined ? trackInfo.source_track_id : existingTrack.source_track_id,
                    container: format.container,
                    is_fragmented: format.is_fragmented,
                    stream_layout: format.stream_layout,
                    has_video: format.has_video,
                    has_audio: format.has_audio,
                    streams: format.streams,
                    update_time: now,
                })
                .where(eq(Track.id, existingTrack.id))
                .returning();
            resultTrack = updated;
        } else {
            const [inserted] = await tx
                .insert(Track)
                .values({
                    media_id: mediaId,
                    file_id: fileRecord.id,
                    type: trackInfo.type,
                    purpose: trackInfo.purpose,
                    is_original: true,
                    is_generated: false,
                    quality: trackInfo.quality,
                    priority: trackInfo.priority,
                    source_url: trackInfo.source_url || "",
                    sync_status: SyncStatus.COMPLETED,
                    metadata,
                    container: format.container,
                    is_fragmented: format.is_fragmented,
                    stream_layout: format.stream_layout,
                    has_video: format.has_video,
                    has_audio: format.has_audio,
                    streams: format.streams,
                    variant_key,
                    is_default,
                    is_primary,
                    display_name: trackInfo.display_name,
                    language,
                    codec,
                    duration,
                    width,
                    height,
                    bandwidth,
                    source_track_id: trackInfo.source_track_id || null,
                    create_time: now,
                    update_time: now,
                })
                .returning();
            resultTrack = inserted;
        }

        // 4. Mark media and post sync status as COMPLETED
        await MediaService.syncMediaAndPostStatus(mediaId, tx, now);

        // 5. Soft-delete old file if it is no longer referenced anywhere
        if (oldFileId && oldFileId !== fileRecord.id) {
            await DeleteService.softDeleteFileIfUnreferenced(oldFileId, tx, now);
        }

        // 6. Return updated track with physical File object
        return {
            track: resultTrack,
            file: fileRecord,
        };
    },

    async replaceFile(mediaId: string, trackId: string, fileData: FileData) {
        return db.transaction(async (tx) => {
            const now = Temporal.Now.instant();

            const [existingTrack] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!existingTrack) {
                throw new Error("Track not found");
            }

            const oldFileId = existingTrack.file_id;
            const newFile = await resolveFileRecord(tx, fileData);

            const finalMetadata = (existingTrack.metadata as Record<string, unknown>) ?? {};
            const format = deriveTrackFormat({
                type: existingTrack.type,
                metadata: finalMetadata,
                file: newFile,
            });

            const [updatedTrack] = await tx
                .update(Track)
                .set({
                    file_id: newFile.id,
                    metadata: finalMetadata,
                    container: format.container,
                    is_fragmented: format.is_fragmented,
                    stream_layout: format.stream_layout,
                    has_video: format.has_video,
                    has_audio: format.has_audio,
                    streams: format.streams,
                    codec: typeof finalMetadata.codecs === "string" ? finalMetadata.codecs : null,
                    is_stale: false,
                    update_time: now,
                })
                .where(eq(Track.id, trackId))
                .returning();

            if (oldFileId && oldFileId !== newFile.id) {
                await DeleteService.softDeleteFileIfUnreferenced(oldFileId, tx, now);
            }

            return {
                track: updatedTrack,
                file: newFile,
            };
        });
    },

    async deleteTrack(mediaId: string, trackId: string) {
        return db.transaction(async (tx) => {
            const now = Temporal.Now.instant();

            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found");
            }

            await tx
                .update(Track)
                .set({
                    delete_status: DeleteStatus.DELETED,
                    delete_time: now,
                })
                .where(eq(Track.id, trackId));

            await DeleteService.softDeleteFileIfUnreferenced(trackRecord.file_id, tx, now);

            return { success: true };
        });
    },

    async updateTrackMetadata(mediaId: string, trackId: string, updates: UpdateTrackMetadataInput) {
        return db.transaction(async (tx) => {
            const now = Temporal.Now.instant();

            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found");
            }

            const finalMetadata =
                updates.metadata !== undefined ? prepareTrackMetadata(updates.metadata) : (trackRecord.metadata as Record<string, unknown>);
            const formatUpdate = resolveFormatUpdate(updates, trackRecord);
            const format = deriveTrackFormat({
                type: trackRecord.type,
                metadata: finalMetadata,
                ...formatUpdate,
            });

            const setParams: Partial<typeof Track.$inferSelect> = {
                update_time: now,
                metadata: finalMetadata,
                container: format.container,
                is_fragmented: format.is_fragmented,
                stream_layout: format.stream_layout,
                has_video: format.has_video,
                has_audio: format.has_audio,
                streams: format.streams,
            };

            if (updates.priority !== undefined) setParams.priority = updates.priority;
            if (updates.quality !== undefined) setParams.quality = updates.quality;
            if (updates.display_name !== undefined) setParams.display_name = updates.display_name;
            if (updates.variant_key !== undefined) setParams.variant_key = updates.variant_key;
            if (updates.is_default !== undefined) setParams.is_default = updates.is_default;
            if (updates.is_primary !== undefined) setParams.is_primary = updates.is_primary;
            if (updates.language !== undefined) setParams.language = updates.language;
            if (updates.codec !== undefined) setParams.codec = updates.codec;
            if (updates.is_stale !== undefined) setParams.is_stale = updates.is_stale;
            if (updates.source_track_id !== undefined) setParams.source_track_id = updates.source_track_id;

            if (updates.is_default === true) {
                await unsetOtherDefaults(tx, mediaId, trackRecord.type, trackRecord.purpose, now, trackId);
            }

            if (updates.is_primary === true) {
                await unsetOtherPrimaries(tx, mediaId, now, trackId);
            }

            const [updated] = await tx.update(Track).set(setParams).where(eq(Track.id, trackId)).returning();

            return updated;
        });
    },
};
