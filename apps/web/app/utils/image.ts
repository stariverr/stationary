const trimTrailingSlash = (value: string) =>
    value.endsWith("/") ? value.slice(0, -1) : value;

const trimLeadingSlash = (value: string) =>
    value.startsWith("/") ? value.slice(1) : value;

const stripCloudflareImagePrefix = (pathname: string) => {
    const prefix = "/cdn-cgi/image/";
    if (!pathname.startsWith(prefix)) return pathname;

    const pathAfterPrefix = pathname.slice(prefix.length);
    const imagePathStart = pathAfterPrefix.indexOf("/");
    if (imagePathStart === -1) return pathname;

    return pathAfterPrefix.slice(imagePathStart);
};

const resolveAssetUrlParts = (url: string, fallbackOrigin: string) => {
    try {
        const parsed = new URL(url);
        const pathname = stripCloudflareImagePrefix(parsed.pathname);
        return {
            origin: parsed.origin,
            path: trimLeadingSlash(`${pathname}${parsed.search}`),
        };
    } catch {
        return {
            origin: fallbackOrigin,
            path: trimLeadingSlash(url),
        };
    }
};

export interface ImageOptimizerOptions {
    width?: number;
    height?: number;
    fit?: "cover" | "contain" | "scale-down" | "crop" | "pad";
    quality?: number;
    format?: "avif" | "webp" | "jpeg" | "png" | "auto";
    gravity?: "auto" | "side" | "north" | "south" | "east" | "west";
}

/**
 * Generates an optimized image URL using Cloudflare Image Resizing or returns the original if bypassed.
 */
export function getOptimizedImageUrl(
    url: string | null | undefined,
    options: ImageOptimizerOptions = {},
): string {
    if (!url) return "";

    // Skip video formats, AVIF source files, and HEIC/HEIF files (Cloudflare Resizing does not support them as source images)
    if (url.match(/\.(mp4|webm|mov|ogg|avi|avif|heic|heif)($|\?)/i)) {
        return url;
    }

    // Bypass transformation for local development/localhost URLs
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
        return url;
    }

    const config = useRuntimeConfig();
    const provider = config.public.imageProvider || "cloudflare";
    const configuredCdnBase =
        typeof config.public.cdnBaseUrl === "string" ? config.public.cdnBaseUrl : "";
    const fallbackOrigin = trimTrailingSlash(configuredCdnBase);
    const assetUrl = resolveAssetUrlParts(url, fallbackOrigin);

    if (provider === "none") {
        if (!assetUrl.origin) return url;
        return `${assetUrl.origin}/${assetUrl.path}`;
    }

    // Cloudflare Image Resizing inserts the transformation segment between the origin and asset path.
    const { width, height, fit, quality = 75, format = "avif", gravity } = options;

    const params: string[] = [];
    if (width) params.push(`width=${width}`);
    if (height) params.push(`height=${height}`);
    if (fit) params.push(`fit=${fit}`);
    if (quality) params.push(`quality=${quality}`);
    if (format) params.push(`format=${format}`);
    if (gravity) params.push(`gravity=${gravity}`);

    const optionsStr = params.join(",");
    if (!assetUrl.origin) return url;
    return `${assetUrl.origin}/cdn-cgi/image/${optionsStr}/${assetUrl.path}`;
}

/**
 * Generates the responsive srcset attribute for list (4:3 ratio) or detail view.
 */
export function getOptimizedSrcset(
    url: string | null | undefined,
    type: "list" | "detail",
): string {
    if (!url) return "";

    // Skip generating srcset for AVIF and HEIC source files to avoid duplicate entries of same unoptimized URL
    if (url.match(/\.(avif|heic|heif)($|\?)/i)) {
        return "";
    }

    if (type === "list") {
        // 320x240, 480x360, 640x480
        const s320 = getOptimizedImageUrl(url, {
            width: 320,
            height: 240,
            fit: "cover",
            gravity: "auto",
        });
        const s480 = getOptimizedImageUrl(url, {
            width: 480,
            height: 360,
            fit: "cover",
            gravity: "auto",
        });
        const s640 = getOptimizedImageUrl(url, {
            width: 640,
            height: 480,
            fit: "cover",
            gravity: "auto",
        });
        return `${s320} 320w, ${s480} 480w, ${s640} 640w`;
    } else {
        // 640w, 960w, 1200w
        const s640 = getOptimizedImageUrl(url, { width: 640, fit: "scale-down" });
        const s960 = getOptimizedImageUrl(url, { width: 960, fit: "scale-down" });
        const s1200 = getOptimizedImageUrl(url, { width: 1200, fit: "scale-down" });
        return `${s640} 640w, ${s960} 960w, ${s1200} 1200w`;
    }
}
