import { env } from "@/global/env";

/**
 * Builds the public asset URL for a stored file.
 */
export function buildCdnUrl(_bucket: string | null | undefined, path: string | null | undefined): string | null {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;

    const cleanBase = env.CDN_BASE_URL.replace(/\/+$/, "");
    const cleanPath = path.replace(/^\/+/, "");
    return `${cleanBase}/${cleanPath}`;
}



