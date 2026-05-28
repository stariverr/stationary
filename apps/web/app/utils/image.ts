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

    // Skip video formats
    if (url.match(/\.(mp4|webm|mov|ogg|avi)($|\?)/i)) {
        return url;
    }

    // Bypass transformation for local development/localhost URLs
    if (url.includes("localhost") || url.includes("127.0.0.1")) {
        return url;
    }

    const config = useRuntimeConfig();
    const provider = config.public.imageProvider || "cloudflare";
    const cdnBase = config.public.cdnBaseUrl || "";

    let origin = cdnBase.replace(/\/$/, "");
    let path = url;

    if (url.startsWith("http")) {
        try {
            const parsed = new URL(url);
            origin = parsed.origin;
            path = parsed.pathname + parsed.search;
        } catch {
            // Fallback
        }
    }

    path = path.replace(/^\//, "");

    if (provider === "none") {
        return `${origin}/${path}`;
    }

    // Cloudflare format
    const { width, height, fit, quality = 75, format = "avif", gravity } = options;

    const params: string[] = [];
    if (width) params.push(`width=${width}`);
    if (height) params.push(`height=${height}`);
    if (fit) params.push(`fit=${fit}`);
    if (quality) params.push(`quality=${quality}`);
    if (format) params.push(`format=${format}`);
    if (gravity) params.push(`gravity=${gravity}`);

    const optionsStr = params.join(",");
    return `${origin}/cdn-cgi/image/${optionsStr}/${path}`;
}

/**
 * Generates the responsive srcset attribute for list (4:3 ratio) or detail view.
 */
export function getOptimizedSrcset(
    url: string | null | undefined,
    type: "list" | "detail",
): string {
    if (!url) return "";

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
