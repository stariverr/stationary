import { FileCategory, MediaType } from "../types/post";
export { FileCategory, MediaType };

export interface DraftFileDescriptor {
    name: string;
    mime_type: string;
}

/** What a draft file becomes in its media: one of its originals, its cover or one of its captions. */
export enum DraftFileRole {
    ORIGINAL = "ORIGINAL",
    COVER = "COVER",
    CAPTION = "CAPTION",
}

/** A draft file placed in a media draft; language, label and is_default only matter for captions. */
export interface DraftFileConfig extends DraftFileDescriptor {
    draft_file_id: string;
    language: string;
    label: string;
    is_default: boolean;
}

/** The draft of one media as `/api/import/draft/commit-media` and post creation take it. */
export interface MediaDraftPayload {
    title: string;
    type: MediaType;
    originals: string[];
    cover: string | null;
    captions: { draft_file_id: string; language: string | null; label: string | null; is_default: boolean }[];
}

/**
 * NOTE: The following file classification rules, extension lists, and mime mapping logic
 * are synchronized with the backend.
 * Source Of Truth: apps/server/src/lib/utils/file.ts (getFileCategories)
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

export function getFileCategories(fileName: string, mimeType = ""): FileCategory[] {
    const extension = getFileExtension(fileName);
    if (ambiguousExtensions.has(extension)) return [FileCategory.VIDEO, FileCategory.AUDIO];
    if (imageExtensions.has(extension)) return [FileCategory.IMAGE];
    if (videoExtensions.has(extension)) return [FileCategory.VIDEO];
    if (audioExtensions.has(extension)) return [FileCategory.AUDIO];
    if (subtitleExtensions.has(extension)) return [FileCategory.SUBTITLE];
    if (extension === "pdf") return [FileCategory.PDF];

    const normalizedMime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (normalizedMime === "application/pdf") return [FileCategory.PDF];
    if (normalizedMime === "application/mp4" || normalizedMime.includes("iso.segment")) {
        return [FileCategory.VIDEO, FileCategory.AUDIO];
    }
    if (normalizedMime.startsWith("image/")) return [FileCategory.IMAGE];
    if (normalizedMime.startsWith("video/")) return [FileCategory.VIDEO];
    if (normalizedMime.startsWith("audio/")) return [FileCategory.AUDIO];
    if (
        normalizedMime === "text/vtt" ||
        normalizedMime === "application/x-subrip" ||
        normalizedMime.includes("subtitle") ||
        normalizedMime.includes("subrip")
    ) {
        return [FileCategory.SUBTITLE];
    }
    return [];
}

/**
 * NOTE: What each role takes, by file category, per media type. The server checks the probed streams after commit;
 * this only mirrors the checks it runs on file names.
 * Source Of Truth: apps/server/src/lib/validation/media-composition.ts (ORIGINAL_CATEGORIES, COVER_MEDIA_TYPES,
 * CAPTION_MEDIA_TYPES) and apps/server/src/features/media/originals.ts (compositionError)
 */
const originalCategories: Record<MediaType, readonly FileCategory[]> = {
    [MediaType.IMAGE]: [FileCategory.IMAGE],
    [MediaType.VIDEO]: [FileCategory.VIDEO, FileCategory.AUDIO],
    [MediaType.AUDIO]: [FileCategory.AUDIO, FileCategory.VIDEO],
    [MediaType.LIVE_PHOTO]: [FileCategory.IMAGE, FileCategory.VIDEO],
    [MediaType.PDF]: [FileCategory.PDF],
};
const coverMediaTypes: ReadonlySet<MediaType> = new Set([MediaType.VIDEO, MediaType.AUDIO, MediaType.PDF]);
const captionMediaTypes: ReadonlySet<MediaType> = new Set([MediaType.VIDEO, MediaType.AUDIO]);

/**
 * The role a file takes in a media of this type, or null when it fits none. Captions are subtitle files, a cover is the
 * image of a VIDEO, AUDIO or PDF; everything else of a fitting category is an original.
 */
export function getDraftFileRole(mediaType: MediaType, file: DraftFileDescriptor): DraftFileRole | null {
    const categories = getFileCategories(file.name, file.mime_type);
    if (categories.includes(FileCategory.SUBTITLE)) return captionMediaTypes.has(mediaType) ? DraftFileRole.CAPTION : null;
    if (categories.includes(FileCategory.IMAGE) && coverMediaTypes.has(mediaType)) return DraftFileRole.COVER;
    return categories.some((category) => originalCategories[mediaType].includes(category)) ? DraftFileRole.ORIGINAL : null;
}

export interface DraftCompositionError {
    key: string;
    params?: Record<string, string | number>;
}

/**
 * Checks a media draft by file category: every file fits a role, the originals add up to what the media type takes
 * (VIDEO: one file that can hold video plus audio-only files; LIVE_PHOTO: an image and a video; the others: one file),
 * at most one cover and at most one default caption.
 */
export function getDraftCompositionError(
    mediaType: MediaType,
    files: Array<DraftFileDescriptor & { is_default?: boolean }>,
): DraftCompositionError | null {
    if (files.length === 0) return { key: "media.errors.select_at_least_one" };

    const unfit = files.find((file) => !getDraftFileRole(mediaType, file));
    if (unfit) return { key: "media.errors.file_not_allowed", params: { name: unfit.name, mediaType } };

    const withRole = (role: DraftFileRole) => files.filter((file) => getDraftFileRole(mediaType, file) === role);
    const originals = withRole(DraftFileRole.ORIGINAL).map((file) => getFileCategories(file.name, file.mime_type));
    const can = (categories: FileCategory[], category: FileCategory) => categories.includes(category);
    const only = (categories: FileCategory[], category: FileCategory) => categories.length === 1 && categories[0] === category;

    const fits = (() => {
        switch (mediaType) {
            case MediaType.VIDEO:
                return (
                    originals.some((categories) => can(categories, FileCategory.VIDEO)) &&
                    originals.filter((categories) => only(categories, FileCategory.VIDEO)).length <= 1
                );
            case MediaType.LIVE_PHOTO:
                return (
                    originals.length === 2 &&
                    originals.some((categories) => can(categories, FileCategory.IMAGE)) &&
                    originals.some((categories) => can(categories, FileCategory.VIDEO))
                );
            default:
                return originals.length === 1;
        }
    })();
    if (!fits) return { key: `media.errors.originals_${mediaType.toLowerCase()}` };

    if (withRole(DraftFileRole.COVER).length > 1) return { key: "media.errors.only_one_cover_allowed" };
    if (withRole(DraftFileRole.CAPTION).filter((file) => file.is_default).length > 1) {
        return { key: "media.errors.only_one_default_caption" };
    }
    return null;
}

export function getCompatibleMediaTypes(files: DraftFileDescriptor[]): MediaType[] {
    if (files.length === 0) return [];
    return (Object.values(MediaType) as MediaType[]).filter((mediaType) => getDraftCompositionError(mediaType, files) === null);
}

/** The media type a set of files most likely makes: video before audio, then whatever fits first. */
export function guessMediaType(files: DraftFileDescriptor[]): MediaType | null {
    const compatible = getCompatibleMediaTypes(files);
    if (compatible.includes(MediaType.VIDEO)) return MediaType.VIDEO;
    if (compatible.includes(MediaType.AUDIO)) return MediaType.AUDIO;
    return compatible[0] ?? null;
}

/** Splits the files of a media draft into originals, cover and captions, in the order they are listed. */
export function buildMediaDraft(title: string, mediaType: MediaType, files: DraftFileConfig[]): MediaDraftPayload {
    const withRole = (role: DraftFileRole) => files.filter((file) => getDraftFileRole(mediaType, file) === role);
    return {
        title,
        type: mediaType,
        originals: withRole(DraftFileRole.ORIGINAL).map((file) => file.draft_file_id),
        cover: withRole(DraftFileRole.COVER)[0]?.draft_file_id ?? null,
        captions: withRole(DraftFileRole.CAPTION).map((file) => ({
            draft_file_id: file.draft_file_id,
            language: file.language.trim() || null,
            label: file.label.trim() || null,
            is_default: file.is_default,
        })),
    };
}

/** A draft file as a fresh config, with no caption details yet. */
export function toDraftFileConfig(file: { id: string; name: string; mime_type: string }): DraftFileConfig {
    return { draft_file_id: file.id, name: file.name, mime_type: file.mime_type, language: "", label: "", is_default: false };
}

/** A media draft staged in the post creation dialog until the post is created. */
export interface StagedMediaDraft {
    temp_id: string;
    title: string;
    type: MediaType;
    files: DraftFileConfig[];
    /** The draft files behind `files`, for display. */
    _files: { id: string; name: string; mime_type: string; size: number | null; url?: string }[];
    /** Files picked from the draft box rather than uploaded here; they stay in the box if the draft is discarded. */
    preExistingDraftFileIds: string[];
}
