import { MediaType, TrackPurpose, TrackType, type MediaPreviews } from "@/types/post";

interface SelectableTrack {
    type: string;
    purpose: string;
    is_default?: boolean;
    is_original?: boolean;
    priority?: number;
    quality?: string;
}

const qualityRank: Record<string, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/** Orders tracks by ascending priority, then by descending quality. */
export function sortTracks<T extends SelectableTrack>(tracks: T[]): T[] {
    return [...tracks].sort((a, b) => {
        const priorityA = a.priority ?? 999;
        const priorityB = b.priority ?? 999;
        if (priorityA !== priorityB) return priorityA - priorityB;
        return (qualityRank[b.quality || ""] || 0) - (qualityRank[a.quality || ""] || 0);
    });
}

/** Picks the track a viewer plays or shows for a track type. */
export function selectContentTrack<T extends SelectableTrack>(tracks: T[] | undefined, type: string): T | undefined {
    const candidates = sortTracks((tracks || []).filter((track) => track.type.toUpperCase() === type));
    return (
        candidates.find((track) => track.is_default) ||
        candidates.find((track) => track.purpose.toUpperCase() === TrackPurpose.CONTENT) ||
        candidates[0]
    );
}

/** The file behind a media item that a viewer downloads or opens: its original content track when it has one. */
export function selectOriginalTrack<T extends SelectableTrack>(media: { type: MediaType; tracks?: T[] }): T | undefined {
    const trackType = media.type === MediaType.LIVE_PHOTO ? TrackType.IMAGE : media.type;
    const original = (media.tracks || []).find(
        (track) => track.is_original && track.type.toUpperCase() === trackType && track.purpose.toUpperCase() === TrackPurpose.CONTENT,
    );
    return original ?? selectContentTrack(media.tracks, trackType);
}

/**
 * Helper function to translate media type codes into localized labels using a switch statement.
 */
export function getMediaTypeLabel(type: string | null | undefined, t: (key: string) => string): string {
    switch (type?.toUpperCase()) {
        case "VIDEO":
            return t("common.media_type_video");
        case "IMAGE":
            return t("common.media_type_image");
        case "LIVE_PHOTO":
            return t("common.media_type_live_photo");
        case "AUDIO":
            return t("common.media_type_audio");
        case "PDF":
            return t("common.media_type_pdf");
        default:
            return type || "";
    }
}

/** Only VIDEO, AUDIO and PDF can carry an original cover; images and live photos are their own preview source. */
export function canHaveCover(type: string | null | undefined): boolean {
    const upper = type?.toUpperCase();
    return upper === MediaType.VIDEO || upper === MediaType.AUDIO || upper === MediaType.PDF;
}

/** The smallest generated preview, for thumbnails and grid cards. */
export function previewThumbnailUrl(previews: MediaPreviews | null | undefined): string | null {
    return previews?.small?.url ?? previews?.medium?.url ?? previews?.large?.url ?? null;
}

/** The preview a video player shows before playback starts. */
export function previewPosterUrl(previews: MediaPreviews | null | undefined): string | null {
    return previews?.large?.url ?? previews?.medium?.url ?? null;
}

/** The largest generated preview, for views that fill most of the screen. */
export function previewLargestUrl(previews: MediaPreviews | null | undefined): string | null {
    return previews?.large?.url ?? previews?.medium?.url ?? previews?.small?.url ?? null;
}

/** A `srcset` over every generated preview, described by its real width. */
export function previewSrcset(previews: MediaPreviews | null | undefined): string | null {
    if (!previews) return null;
    const parts = [previews.small, previews.medium, previews.large]
        .filter((preview) => !!preview)
        .map((preview) => `${preview.url} ${preview.width}w`);
    return parts.length > 0 ? parts.join(", ") : null;
}

/**
 * Format bytes into human-readable strings (B, KB, MB, GB, TB).
 */
export function formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}
