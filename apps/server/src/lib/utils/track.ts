export function normalizeVariantKey(key: string): string {
    const slug = key
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "-") // replace invalid chars with hyphen
        .replace(/-+/g, "-") // collapse consecutive hyphens
        .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
    return slug || "variant"; // non-empty fallback
}

export function generateDeterministicVariantKey(
    track: {
        type: string;
        purpose: string;
        quality: string;
        priority: number;
        metadata?: any;
        language?: string | null;
        codec?: string | null;
    },
    file?: {
        extension?: string | null;
        mime_type?: string | null;
        width?: number | null;
        height?: number | null;
        duration?: number | null;
    } | null,
): string {
    const type = track.type.toUpperCase();
    const quality = (track.quality || "ORIGINAL").toUpperCase();
    const priority = track.priority ?? 0;
    const metadata = track.metadata || {};

    // Leverage physical File properties (fallback to metadata)
    const width = file?.width ?? metadata.width ?? 0;
    const height = file?.height ?? metadata.height ?? 0;
    const lang = (track.language ?? metadata.language ?? "unknown").toLowerCase().replace(/_/g, "-");
    const codecStr = (track.codec ?? metadata.codecs ?? "").toLowerCase();

    let key = "";

    if (type === "SUBTITLE") {
        const format = (metadata.format ?? file?.extension ?? "vtt").toLowerCase();
        key = `${lang}-${format}`;
    } else if (type === "AUDIO") {
        const codec = codecStr.replace(/[^a-z0-9]/g, "") || "aac";
        key = `${lang}-${codec}`;
    } else if (type === "VIDEO") {
        if (quality === "ORIGINAL" && priority === 0) {
            key = "original-video";
        } else {
            const h = height ? `${height}p` : "video";
            const codec = codecStr.includes("hvc") || codecStr.includes("h265") ? "hevc" : "avc";
            key = `${h}-${codec}`;
        }
    } else {
        // IMAGE
        if (quality === "ORIGINAL" && priority === 0) {
            key = "original";
        } else {
            const ext = (file?.extension ?? metadata.format ?? "jpeg").toLowerCase();
            key = width && height ? `${ext}-${width}x${height}` : `${ext}-image`;
        }
    }

    // Append priority rank only if priority > 0
    if (priority > 0) {
        key += `-rank${priority}`;
    }

    const normalized = normalizeVariantKey(key);
    return normalized === "variant" ? `legacy-${type.toLowerCase()}-${priority}` : normalized;
}
