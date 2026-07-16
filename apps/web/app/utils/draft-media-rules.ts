import { TrackType, TrackPurpose, MediaType } from "../types/post";
export { TrackType, TrackPurpose, MediaType };

export interface DraftFileDescriptor {
    name: string;
    mime_type: string;
}

export interface DraftTrackConfigBase extends DraftFileDescriptor {
    type: TrackType | null;
    purpose: TrackPurpose;
    is_default: boolean;
}

/**
 * NOTE: The following file classification rules, extension lists, and mime mapping logic
 * are synchronized with the backend.
 * Source Of Truth: apps/server/src/lib/utils/file.ts
 */
const ambiguousExtensions = new Set(["mp4", "m4s"]);
const imageExtensions = new Set(["apng", "avif", "gif", "heic", "heif", "jfif", "jpe", "jpeg", "jpg", "jxl", "png", "svg", "webp"]);
const videoExtensions = new Set(["avi", "flv", "m4v", "mkv", "mov", "ts", "webm", "wmv", "mp4"]);
const audioExtensions = new Set(["aac", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]);
const subtitleExtensions = new Set(["ass", "srt", "vtt"]);

export function normalizeFileExtension(extension: string): string {
    return extension.trim().replace(/^\./, "").toLowerCase();
}

export function getFileExtension(fileName: string): string {
    const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
    const dotIndex = baseName.lastIndexOf(".");
    return dotIndex > 0 && dotIndex < baseName.length - 1 ? normalizeFileExtension(baseName.slice(dotIndex + 1)) : "";
}

export function getAllowedFileTrackTypes(fileName: string, mimeType = ""): TrackType[] {
    const extension = getFileExtension(fileName);
    if (ambiguousExtensions.has(extension)) return [TrackType.VIDEO, TrackType.AUDIO];
    if (imageExtensions.has(extension)) return [TrackType.IMAGE];
    if (videoExtensions.has(extension)) return [TrackType.VIDEO];
    if (audioExtensions.has(extension)) return [TrackType.AUDIO];
    if (subtitleExtensions.has(extension)) return [TrackType.SUBTITLE];
    if (extension === "pdf") return [TrackType.PDF];

    const normalizedMime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (normalizedMime === "application/pdf") return [TrackType.PDF];
    if (normalizedMime === "application/mp4" || normalizedMime.includes("iso.segment")) {
        return [TrackType.VIDEO, TrackType.AUDIO];
    }
    if (normalizedMime.startsWith("image/")) return [TrackType.IMAGE];
    if (normalizedMime.startsWith("video/")) return [TrackType.VIDEO];
    if (normalizedMime.startsWith("audio/")) return [TrackType.AUDIO];
    if (
        normalizedMime === "text/vtt" ||
        normalizedMime === "application/x-subrip" ||
        normalizedMime.includes("subtitle") ||
        normalizedMime.includes("subrip")
    ) {
        return [TrackType.SUBTITLE];
    }
    return [];
}

export { getAllowedFileTrackTypes as getAllowedTrackTypesForFile };

/**
 * NOTE: The allowed track types, purposes, and composition requirements for each media type.
 * Source Of Truth: apps/server/src/lib/validation/media-composition.ts
 */
const mediaTrackPurposes: Record<MediaType, Partial<Record<TrackType, readonly TrackPurpose[]>>> = {
    [MediaType.IMAGE]: {
        [TrackType.IMAGE]: [TrackPurpose.CONTENT, TrackPurpose.COVER, TrackPurpose.THUMBNAIL, TrackPurpose.PREVIEW],
    },
    [MediaType.VIDEO]: {
        [TrackType.IMAGE]: [TrackPurpose.COVER, TrackPurpose.THUMBNAIL, TrackPurpose.PREVIEW],
        [TrackType.VIDEO]: [TrackPurpose.CONTENT, TrackPurpose.PREVIEW],
        [TrackType.AUDIO]: [TrackPurpose.CONTENT, TrackPurpose.PREVIEW],
        [TrackType.SUBTITLE]: [TrackPurpose.CONTENT],
    },
    [MediaType.LIVE_PHOTO]: {
        [TrackType.IMAGE]: [TrackPurpose.CONTENT, TrackPurpose.COVER, TrackPurpose.THUMBNAIL, TrackPurpose.PREVIEW],
        [TrackType.VIDEO]: [TrackPurpose.CONTENT, TrackPurpose.PREVIEW],
        [TrackType.AUDIO]: [TrackPurpose.CONTENT, TrackPurpose.PREVIEW],
        [TrackType.SUBTITLE]: [TrackPurpose.CONTENT],
    },
    [MediaType.AUDIO]: {
        [TrackType.IMAGE]: [TrackPurpose.COVER, TrackPurpose.THUMBNAIL, TrackPurpose.PREVIEW],
        [TrackType.AUDIO]: [TrackPurpose.CONTENT, TrackPurpose.PREVIEW],
        [TrackType.SUBTITLE]: [TrackPurpose.CONTENT],
    },
    [MediaType.PDF]: {
        [TrackType.IMAGE]: [TrackPurpose.COVER, TrackPurpose.THUMBNAIL, TrackPurpose.PREVIEW],
        [TrackType.PDF]: [TrackPurpose.CONTENT],
    },
};

/**
 * NOTE: Required core tracks for each media type.
 * Source Of Truth: apps/server/src/lib/validation/media-composition.ts (requiredTrackTypeByMedia / validateMediaComposition)
 */
const requiredContentTypes: Record<MediaType, readonly TrackType[]> = {
    [MediaType.IMAGE]: [TrackType.IMAGE],
    [MediaType.VIDEO]: [TrackType.VIDEO],
    [MediaType.LIVE_PHOTO]: [TrackType.IMAGE, TrackType.VIDEO],
    [MediaType.AUDIO]: [TrackType.AUDIO],
    [MediaType.PDF]: [TrackType.PDF],
};

export function getAllowedTrackPurposes(mediaType: MediaType, trackType: TrackType | null): TrackPurpose[] {
    if (!trackType) return [];
    return [...(mediaTrackPurposes[mediaType]?.[trackType] ?? [])];
}

export function getRequiredContentTrackTypes(mediaType: MediaType): TrackType[] {
    return [...requiredContentTypes[mediaType]];
}

export function isLanguageTrackType(trackType: TrackType | null): boolean {
    return trackType === TrackType.AUDIO || trackType === TrackType.SUBTITLE;
}

function getSupportedFileTypesForMedia(file: DraftFileDescriptor, mediaType: MediaType): TrackType[] {
    return getAllowedFileTrackTypes(file.name, file.mime_type).filter((type) => getAllowedTrackPurposes(mediaType, type).length > 0);
}

function findRequiredTrackAssignment(
    files: Array<DraftFileDescriptor & { type?: TrackType | null }>,
    mediaType: MediaType,
): Map<TrackType, number> | null {
    const requiredTypes = getRequiredContentTrackTypes(mediaType);
    const assignment = new Map<TrackType, number>();
    const usedIndexes = new Set<number>();

    function assign(requiredIndex: number): boolean {
        if (requiredIndex >= requiredTypes.length) return true;
        const requiredType = requiredTypes[requiredIndex]!;
        const candidates = files
            .map((file, index) => ({ file, index }))
            .filter(
                ({ file, index }) => !usedIndexes.has(index) && getAllowedFileTrackTypes(file.name, file.mime_type).includes(requiredType),
            )
            .sort((a, b) => Number(b.file.type === requiredType) - Number(a.file.type === requiredType));

        for (const { index } of candidates) {
            usedIndexes.add(index);
            assignment.set(requiredType, index);
            if (assign(requiredIndex + 1)) return true;
            usedIndexes.delete(index);
            assignment.delete(requiredType);
        }
        return false;
    }

    return assign(0) ? assignment : null;
}

export function getCompatibleMediaTypes(files: DraftFileDescriptor[]): MediaType[] {
    if (files.length === 0) return [];
    return (Object.values(MediaType) as MediaType[]).filter((mediaType) => {
        if (files.some((file) => getSupportedFileTypesForMedia(file, mediaType).length === 0)) return false;
        return findRequiredTrackAssignment(files, mediaType) !== null;
    });
}

export function normalizeDraftTracksForMedia<T extends DraftTrackConfigBase>(mediaType: MediaType, tracks: T[]): T[] {
    const nextTracks = tracks.map((track) => ({ ...track }));
    const requiredAssignment = findRequiredTrackAssignment(nextTracks, mediaType);
    if (!requiredAssignment) return nextTracks;

    const forcedTypeByIndex = new Map<number, TrackType>();
    for (const [requiredType, trackIndex] of requiredAssignment) {
        forcedTypeByIndex.set(trackIndex, requiredType);
    }

    nextTracks.forEach((track, index) => {
        const forcedType = forcedTypeByIndex.get(index);
        const supportedTypes = getSupportedFileTypesForMedia(track, mediaType);
        track.type = forcedType ?? (track.type && supportedTypes.includes(track.type) ? track.type : (supportedTypes[0] ?? null));

        const allowedPurposes = getAllowedTrackPurposes(mediaType, track.type);
        if (forcedType) {
            track.purpose = TrackPurpose.CONTENT;
            track.is_default = true;
        } else if (!allowedPurposes.includes(track.purpose)) {
            track.purpose = allowedPurposes.includes(TrackPurpose.CONTENT)
                ? TrackPurpose.CONTENT
                : track.type === TrackType.IMAGE && allowedPurposes.includes(TrackPurpose.COVER)
                  ? TrackPurpose.COVER
                  : (allowedPurposes[0] ?? TrackPurpose.CONTENT);
        }
    });

    const defaultGroups = new Set<string>();
    for (const [index, track] of nextTracks.entries()) {
        if (!forcedTypeByIndex.has(index) || !track.type) continue;
        defaultGroups.add(`${track.type}:${track.purpose}`);
    }
    for (const [index, track] of nextTracks.entries()) {
        if (forcedTypeByIndex.has(index) || !track.is_default || !track.type) continue;
        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) {
            track.is_default = false;
        } else {
            defaultGroups.add(key);
        }
    }

    return nextTracks;
}

export interface DraftCompositionError {
    key: string;
    params?: Record<string, any>;
}

/**
 * NOTE: Composition verification logic for drafting media assets.
 * Source Of Truth: apps/server/src/lib/validation/media-composition.ts (validateMediaComposition)
 */
export function getDraftCompositionError(mediaType: MediaType, tracks: DraftTrackConfigBase[]): DraftCompositionError | null {
    if (tracks.length === 0) return { key: "media.errors.select_at_least_one" };

    for (const track of tracks) {
        const allowedFileTypes = getAllowedFileTrackTypes(track.name, track.mime_type);
        if (allowedFileTypes.length === 0) {
            return { key: "media.errors.not_supported_track", params: { name: track.name } };
        }
        if (!track.type || !allowedFileTypes.includes(track.type)) {
            return {
                key: "media.errors.cannot_be_used_as_type",
                params: { name: track.name, type: track.type ?? "media" },
            };
        }
        if (!getAllowedTrackPurposes(mediaType, track.type).includes(track.purpose)) {
            return {
                key: "media.errors.cannot_use_purpose_in_media",
                params: { type: track.type, purpose: track.purpose, mediaType },
            };
        }
    }

    const defaultGroups = new Set<string>();
    for (const track of tracks) {
        if (!track.is_default || !track.type) continue;
        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) {
            return {
                key: "media.errors.only_one_default_allowed",
                params: { type: track.type, purpose: track.purpose },
            };
        }
        defaultGroups.add(key);
    }

    for (const requiredType of getRequiredContentTrackTypes(mediaType)) {
        const hasRequiredDefault = tracks.some(
            (track) => track.type === requiredType && track.purpose === TrackPurpose.CONTENT && track.is_default,
        );
        if (!hasRequiredDefault) {
            return {
                key: "media.errors.requires_default_content_track",
                params: { mediaType, requiredType },
            };
        }
    }

    return null;
}
