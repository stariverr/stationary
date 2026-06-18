/**
 * @deprecated Backend APIs now return complete asset URLs. Keep this only for
 * legacy compatibility; do not use it for new frontend media rendering paths.
 */
export function cdnPrefix(bucket: string | null | undefined, path: string | null | undefined): string | null {
    void bucket;

    if (!path) return null;
    if (path.startsWith("http")) return path;

    const config = useRuntimeConfig();
    const cdnBase = typeof config.public.cdnBaseUrl === "string" ? config.public.cdnBaseUrl : "";
    const cleanCdnBase = cdnBase.endsWith("/") ? cdnBase.slice(0, -1) : cdnBase;
    const cleanPath = path.startsWith("/") ? path.slice(1) : path;

    return `${cleanCdnBase}/${cleanPath}`;
}
