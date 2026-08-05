import { TrackPurpose, type PostMediaSummary } from "@/types/post";

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

/**
 * Resolves the thumbnail/preview URL for a PostMediaSummary item.
 *
 * **Identity Stabilization Best Practice**:
 * Always prioritizes explicit `cover_url` or primary `url` before track fallbacks.
 * This guarantees the returned URL string is 100% identical before and after async API detail hydration,
 * preventing browser image bitmap flushes and eliminating thumbnail list flickering.
 */
export function getMediaPreviewUrl(media: PostMediaSummary): string | undefined {
    if (media.cover_url) return media.cover_url;
    if (media.url && (media.type === "IMAGE" || media.type === "LIVE_PHOTO")) return media.url;

    const coverTrack = media.tracks.find((track) => track.purpose === TrackPurpose.COVER);
    if (coverTrack?.url) return coverTrack.url;

    return media.tracks.find((track) => track.purpose === TrackPurpose.CONTENT)?.url ?? media.url ?? undefined;
}
