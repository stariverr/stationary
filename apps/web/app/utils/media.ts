import { MediaType, type MediaOriginal, type MediaPreviews } from "@/types/post";

/**
 * Whether this browser can decode a stream with this RFC 6381 codec string. Manifests carry single-stream fMP4, so the
 * check runs against MP4; a stream the server could not describe (no codec string) is left to the player.
 */
export function isCodecSupported(kind: "video" | "audio", codecString: string | null): boolean {
    if (!codecString || !import.meta.client) return true;
    const type = `${kind}/mp4; codecs="${codecString}"`;
    const mediaSource = window.MediaSource ?? (window as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource;
    if (mediaSource) return mediaSource.isTypeSupported(type);
    return document.createElement(kind).canPlayType(type) !== "";
}

/** The original a media is shown by (its `url`), which the viewers open and download. */
export function mainOriginal(media: { url: string | null; originals: MediaOriginal[] }): MediaOriginal | undefined {
    return media.url ? media.originals.find((original) => original.url === media.url) : undefined;
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
