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
