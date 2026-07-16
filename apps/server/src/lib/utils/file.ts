import { TrackType } from "@/db/schema";

const ambiguousExtensions = new Set(["mp4", "m4s"]);
const imageExtensions = new Set(["apng", "avif", "gif", "heic", "heif", "jfif", "jpe", "jpeg", "jpg", "jxl", "png", "svg", "webp"]);
const videoExtensions = new Set(["avi", "flv", "m4v", "mkv", "mov", "ts", "webm", "wmv", "mp4"]);
const audioExtensions = new Set(["aac", "alac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "wma"]);
const subtitleExtensions = new Set(["ass", "srt", "vtt"]);

const mimeTypesByExtension: Record<string, string> = {
    aac: "audio/aac",
    alac: "audio/mp4",
    apng: "image/apng",
    ass: "text/x-ssa",
    avi: "video/x-msvideo",
    avif: "image/avif",
    flac: "audio/flac",
    flv: "video/x-flv",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
    jfif: "image/jpeg",
    jpe: "image/jpeg",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    jxl: "image/jxl",
    m4a: "audio/mp4",
    m4s: "video/iso.segment",
    m4v: "video/x-m4v",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    oga: "audio/ogg",
    ogg: "audio/ogg",
    opus: "audio/ogg",
    pdf: "application/pdf",
    png: "image/png",
    srt: "application/x-subrip",
    ssa: "text/x-ssa",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
    ts: "video/mp2t",
    vtt: "text/vtt",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    wma: "audio/x-ms-wma",
    wmv: "video/x-ms-wmv",
};

export function normalizeFileExtension(extension: string): string {
    return extension.trim().replace(/^\./, "").toLowerCase();
}

export function getFileExtension(fileName: string): string {
    const baseName = fileName.split(/[\\/]/).pop() ?? fileName;
    const dotIndex = baseName.lastIndexOf(".");
    return dotIndex > 0 && dotIndex < baseName.length - 1 ? normalizeFileExtension(baseName.slice(dotIndex + 1)) : "";
}

export function getMimeTypeByExt(extension: string): string {
    return mimeTypesByExtension[normalizeFileExtension(extension)] || "application/octet-stream";
}

export function getAllowedTrackTypesForFile(fileName: string, mimeType = ""): TrackType[] {
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
