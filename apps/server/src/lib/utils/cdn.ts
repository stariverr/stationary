import { env } from "@/global/env";
import { Quality } from "../types";

export interface ImageOptimizerOptions {
    width?: number;
    height?: number;
    fit?: "cover" | "contain" | "scale-down" | "crop" | "pad";
    quality?: number;
    format?: "avif" | "webp" | "jpeg" | "png" | "auto";
    gravity?: "auto" | "side" | "north" | "south" | "east" | "west";
}

const QUALITY_MAP: Record<
    Quality,
    {
        width: number;
        height: number;
        quality: number;
        fit: "scale-down";
        format: "avif";
    }
> = {
    [Quality.LOW]: {
        width: 360,
        height: 360,
        quality: 50,
        fit: "scale-down",
        format: "avif",
    },
    [Quality.MEDIUM]: {
        width: 720,
        height: 720,
        quality: 60,
        fit: "scale-down",
        format: "avif",
    },
    [Quality.HIGH]: {
        width: 1440,
        height: 1440,
        quality: 75,
        fit: "scale-down",
        format: "avif",
    },
    [Quality.ORIGINAL]: {
        width: 3840,
        height: 3840,
        quality: 85,
        fit: "scale-down",
        format: "avif",
    },
};

/**
 * Generates an optimized image URL using Cloudflare Image Resizing parameters.
 */
export function getOptimizedImageUrl(url: string | null | undefined, options: ImageOptimizerOptions = {}): string {
    if (!url) return "";

    // Skip video formats, AVIF source files, and HEIC/HEIF files
    if (url.match(/\.(mp4|webm|mov|ogg|avi|avif|heic|heif)($|\?)/i)) {
        return url;
    }

    // Bypass transformation for local development/localhost URLs
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
        return url;
    }

    const fallbackOrigin = env.CDN_BASE_URL.replace(/\/+$/, "");

    let origin = "";
    let cleanPath = "";
    try {
        const parsed = new URL(url);
        let pathname = parsed.pathname;
        const prefix = "/cdn-cgi/image/";
        if (pathname.startsWith(prefix)) {
            const pathAfterPrefix = pathname.slice(prefix.length);
            const imagePathStart = pathAfterPrefix.indexOf("/");
            if (imagePathStart !== -1) {
                pathname = pathAfterPrefix.slice(imagePathStart);
            }
        }
        origin = parsed.origin;
        cleanPath = `${pathname}${parsed.search}`.replace(/^\/+/, "");
    } catch {
        origin = fallbackOrigin;
        let pathname = url;
        const prefix = "/cdn-cgi/image/";
        if (pathname.startsWith(prefix)) {
            const pathAfterPrefix = pathname.slice(prefix.length);
            const imagePathStart = pathAfterPrefix.indexOf("/");
            if (imagePathStart !== -1) {
                pathname = pathAfterPrefix.slice(imagePathStart);
            }
        }
        cleanPath = pathname.replace(/^\/+/, "");
    }

    const { width, height, fit, quality, format = "avif", gravity } = options;

    const params: string[] = [];
    if (width) params.push(`width=${width}`);
    if (height) params.push(`height=${height}`);
    if (fit) params.push(`fit=${fit}`);
    if (quality !== undefined) params.push(`quality=${quality}`);
    if (format) params.push(`format=${format}`);
    if (gravity) params.push(`gravity=${gravity}`);

    const optionsStr = params.join(",");
    if (!origin) return url;
    return `${origin}/cdn-cgi/image/${optionsStr}/${cleanPath}`;
}

/**
 * Builds the public asset URL for a stored file.
 *
 * This intentionally does not include image transformation parameters.
 */
export function buildCdnUrl(_bucket: string | null | undefined, path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;

    const cleanBase = env.CDN_BASE_URL.replace(/\/+$/, "");
    const cleanPath = path.replace(/^\/+/, "");
    return `${cleanBase}/${cleanPath}`;
}

/**
 * Builds the public asset URL for a stored file, with optional image resizing and optimization.
 */
export function buildImagePreviewCdnUrl(
    _bucket: string | null | undefined,
    path: string | null | undefined,
    quality?: Quality,
): string | null {
    if (!path) return null;

    let fullUrl = path;
    if (!/^https?:\/\//i.test(path)) {
        const cleanBase = env.CDN_BASE_URL.replace(/\/+$/, "");
        const cleanPath = path.replace(/^\/+/, "");
        fullUrl = `${cleanBase}/${cleanPath}`;
    }

    if (!quality) {
        return fullUrl;
    }

    const upperQuality = quality;
    const options = QUALITY_MAP[upperQuality];
    if (!options) {
        return fullUrl;
    }

    return getOptimizedImageUrl(fullUrl, options);
}
