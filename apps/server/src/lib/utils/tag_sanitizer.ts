export function normalizeTagName(name: string): string {
    let clean = name.trim();
    // Remove all leading '#' characters (e.g. ##AI -> AI)
    while (clean.startsWith("#")) {
        clean = clean.slice(1).trim();
    }
    return clean.toLowerCase();
}

const JUNK_KEYWORDS = ["广告", "推广", "福利", "红包", "领券", "优惠", "省钱", "淘口令", "微商", "招商", "拼多多", "淘宝", "京东"];

export function isObviousJunk(name: string): boolean {
    const cleanName = name.trim();
    if (cleanName.length > 15 || cleanName.length === 0) {
        return true;
    }
    const lowerName = cleanName.toLowerCase();
    for (const kw of JUNK_KEYWORDS) {
        if (lowerName.includes(kw)) {
            return true;
        }
    }
    return false;
}

export function sanitizeTags(tags: string[]): { name: string; normalized: string }[] {
    const results: { name: string; normalized: string }[] = [];
    const seen = new Set<string>();

    for (const t of tags) {
        const trimmed = t.trim();
        if (!trimmed) continue;

        const normalized = normalizeTagName(trimmed);
        if (!normalized || isObviousJunk(normalized)) {
            continue;
        }

        if (!seen.has(normalized)) {
            seen.add(normalized);
            // We keep the first occurrence's original casing for the formal tag name
            // but map it to its normalized form for deduplication.
            // Let's strip any leading '#' from the original name as well.
            let cleanOriginal = trimmed;
            while (cleanOriginal.startsWith("#")) {
                cleanOriginal = cleanOriginal.slice(1).trim();
            }
            results.push({
                name: cleanOriginal,
                normalized: normalized,
            });
        }
    }

    return results;
}

export function sanitizeTagAliases(tagName: string, aliases: string[]): string[] {
    const normalizedTagName = normalizeTagName(tagName);
    const seen = new Set<string>();
    const result: string[] = [];

    for (const a of aliases) {
        if (typeof a !== "string") continue;
        const trimmed = a.trim();
        if (!trimmed) continue;

        const normalized = normalizeTagName(trimmed);
        if (normalized === normalizedTagName || isObviousJunk(normalized)) {
            continue;
        }

        if (!seen.has(normalized)) {
            seen.add(normalized);
            let cleanAlias = trimmed;
            while (cleanAlias.startsWith("#")) {
                cleanAlias = cleanAlias.slice(1).trim();
            }
            if (cleanAlias) {
                result.push(cleanAlias);
            }
        }
    }

    return result;
}
