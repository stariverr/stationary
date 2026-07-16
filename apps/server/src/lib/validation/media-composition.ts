import { MediaType, TrackPurpose, TrackType } from "@/db/schema";
import { getAllowedTrackTypesForFile } from "@/lib/utils/file";
import { z } from "zod";
import { Quality } from "@/lib/types";

export const TrackDraftSchema = z.object({
    draft_file_id: z.uuid(),
    type: z.enum(TrackType),
    purpose: z.enum(TrackPurpose),
    quality: z.enum(Quality),
    is_default: z.boolean().default(false),
    language: z.string().nullable().optional(),
});

export const MediaDraftSchema = z.object({
    title: z.string().default(""),
    description: z.string().default(""),
    type: z.enum(MediaType),
    tag_ids: z.array(z.uuid()).optional().default([]),
    tracks: z.array(TrackDraftSchema).min(1, "Each media must have at least one track"),
});

export interface MediaCompositionTrack {
    type: TrackType;
    purpose: TrackPurpose;
    is_default: boolean;
}

export interface DraftMediaCompositionTrack extends MediaCompositionTrack {
    draft_file_id: string;
}

export interface DraftMediaComposition {
    title?: string;
    type: MediaType;
    tracks: DraftMediaCompositionTrack[];
}

export interface DraftFileTypeDescriptor {
    name: string;
    mime_type: string;
}

export interface PrioritizedTrack {
    type: TrackType;
    purpose: TrackPurpose;
    priority: number;
}

const allowedContentTrackTypes: Partial<Record<MediaType, TrackType[]>> = {
    [MediaType.IMAGE]: [TrackType.IMAGE],
    [MediaType.VIDEO]: [TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE],
    [MediaType.AUDIO]: [TrackType.AUDIO, TrackType.SUBTITLE],
    [MediaType.LIVE_PHOTO]: [TrackType.IMAGE, TrackType.VIDEO, TrackType.AUDIO, TrackType.SUBTITLE],
    [MediaType.PDF]: [TrackType.PDF],
};

function hasDefaultContentTrack(tracks: MediaCompositionTrack[], type: TrackType): boolean {
    return tracks.some((track) => track.type === type && track.purpose === TrackPurpose.CONTENT && track.is_default);
}

export function validateMediaComposition(mediaType: MediaType, tracks: MediaCompositionTrack[]): string | null {
    if (tracks.length === 0) {
        return "Media must contain at least one track";
    }

    const allowedContentTypes = allowedContentTrackTypes[mediaType];
    if (!allowedContentTypes) {
        return `${mediaType} media cannot be created from draft tracks`;
    }

    const invalidCover = tracks.find(
        (track) => (track.purpose === TrackPurpose.COVER || track.purpose === TrackPurpose.THUMBNAIL) && track.type !== TrackType.IMAGE,
    );
    if (invalidCover) {
        return `${invalidCover.purpose} tracks must use the IMAGE type`;
    }

    const contentOnlyTrack = tracks.find(
        (track) => (track.type === TrackType.SUBTITLE || track.type === TrackType.PDF) && track.purpose !== TrackPurpose.CONTENT,
    );
    if (contentOnlyTrack) {
        return `${contentOnlyTrack.type} tracks must use the CONTENT purpose`;
    }

    const invalidContentTrack = tracks.find((track) => track.purpose === TrackPurpose.CONTENT && !allowedContentTypes.includes(track.type));
    if (invalidContentTrack) {
        return `${invalidContentTrack.type} CONTENT tracks are not valid for ${mediaType} media`;
    }

    const defaultGroups = new Set<string>();
    for (const track of tracks) {
        if (!track.is_default) continue;

        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) {
            return `Only one default ${track.type} ${track.purpose} track is allowed`;
        }
        defaultGroups.add(key);
    }

    if (mediaType === MediaType.LIVE_PHOTO) {
        if (!hasDefaultContentTrack(tracks, TrackType.IMAGE)) {
            return "LIVE_PHOTO media requires a default IMAGE CONTENT track";
        }
        if (!hasDefaultContentTrack(tracks, TrackType.VIDEO)) {
            return "LIVE_PHOTO media requires a default VIDEO CONTENT track";
        }
        return null;
    }

    const requiredTrackTypeByMedia: Partial<Record<MediaType, TrackType>> = {
        [MediaType.IMAGE]: TrackType.IMAGE,
        [MediaType.VIDEO]: TrackType.VIDEO,
        [MediaType.AUDIO]: TrackType.AUDIO,
        [MediaType.PDF]: TrackType.PDF,
    };
    const requiredTrackType = requiredTrackTypeByMedia[mediaType];
    if (requiredTrackType && !hasDefaultContentTrack(tracks, requiredTrackType)) {
        return `${mediaType} media requires a default ${requiredTrackType} CONTENT track`;
    }

    return null;
}

/**
 * Ensures there are no duplicate draft file references in the media composition tracks.
 * Returns an error message if a duplicate draft file ID is detected, or null if all IDs are unique.
 */
export function validateNoDuplicateDraftFileIds(tracks: DraftMediaCompositionTrack[]): string | null {
    const fileIds = new Set<string>();
    for (const track of tracks) {
        if (fileIds.has(track.draft_file_id)) {
            return `Duplicate file reference detected for draft file ${track.draft_file_id}`;
        }
        fileIds.add(track.draft_file_id);
    }
    return null;
}

export function validateDraftTrackFileTypes(
    groups: DraftMediaComposition[],
    draftFiles: ReadonlyMap<string, DraftFileTypeDescriptor>,
): string | null {
    for (const group of groups) {
        for (const track of group.tracks) {
            const descriptor = draftFiles.get(track.draft_file_id);
            if (!descriptor) continue;

            const allowedTypes = getAllowedTrackTypesForFile(descriptor.name, descriptor.mime_type);
            if (!allowedTypes.includes(track.type)) {
                return `Track type ${track.type} is not allowed for file ${descriptor.name} (${descriptor.mime_type})`;
            }
        }
    }
    return null;
}

export function validateDraftMediaGroups(groups: DraftMediaComposition[]): string | null {
    const draftIdError = validateNoDuplicateDraftFileIds(groups.flatMap((group) => group.tracks));
    if (draftIdError) return draftIdError;

    for (const group of groups) {
        const compositionError = validateMediaComposition(group.type, group.tracks);
        if (compositionError) {
            const groupName = group.title?.trim() || "Untitled media";
            return `${groupName}: ${compositionError}`;
        }
    }

    return null;
}

export function assignTrackPriorities<T extends { type: TrackType; purpose: TrackPurpose }>(
    tracks: T[],
    existingTracks: PrioritizedTrack[] = [],
): Array<T & { priority: number }> {
    const nextPriorityByGroup = new Map<string, number>();

    for (const track of existingTracks) {
        const key = `${track.type}:${track.purpose}`;
        nextPriorityByGroup.set(key, Math.max(nextPriorityByGroup.get(key) ?? 0, track.priority + 1));
    }

    return tracks.map((track) => {
        const key = `${track.type}:${track.purpose}`;
        const priority = nextPriorityByGroup.get(key) ?? 0;
        nextPriorityByGroup.set(key, priority + 1);
        return { ...track, priority };
    });
}
