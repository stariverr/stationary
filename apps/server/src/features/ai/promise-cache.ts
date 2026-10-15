/**
 * A small bounded cache of promises with a time to live. Holding promises (not values) lets
 * concurrent identical requests share one provider call; rejected entries are dropped.
 */
export function createPromiseCache<T>(ttlMs: number, maxEntries: number) {
    const entries = new Map<string, { expiresAt: number; value: Promise<T> }>();
    return {
        getOrCreate(key: string, create: () => Promise<T>): Promise<T> {
            const cached = entries.get(key);
            if (cached && cached.expiresAt > Date.now()) return cached.value;

            const value = create();
            entries.delete(key);
            entries.set(key, { expiresAt: Date.now() + ttlMs, value });
            value.catch(() => {
                if (entries.get(key)?.value === value) entries.delete(key);
            });
            while (entries.size > maxEntries) {
                entries.delete(entries.keys().next().value!);
            }
            return value;
        },
    };
}
