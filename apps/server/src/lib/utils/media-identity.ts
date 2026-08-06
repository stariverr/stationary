export function normalizeExternalId(value: unknown, field = "external_id"): string {
    if (typeof value !== "string") {
        throw new Error(`${field} is required`);
    }

    const normalized = value.trim();
    if (!normalized) {
        throw new Error(`${field} must not be empty`);
    }

    return normalized;
}

export function assertUniqueExternalIds(ids: readonly string[], scope = "media"): void {
    const seen = new Set<string>();
    for (const id of ids) {
        if (seen.has(id)) {
            throw new Error(`Duplicate ${scope} external_id: ${id}`);
        }
        seen.add(id);
    }
}
