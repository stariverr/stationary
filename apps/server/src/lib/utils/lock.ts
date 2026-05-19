import { kv } from "@/global/kv";

interface LockOptions {
    /** Lock expiration time in seconds */
    ttl?: number;
    /** How often to renew the lock while executing, in seconds. Default is ttl / 2 */
    renewalInterval?: number;
}

/**
 * Executes a callback within a distributed lock, automatically renewing the lock's expiration
 * while the callback is running to prevent timeouts on long-running tasks.
 * 
 * @param lockKey The unique key for the lock
 * @param action The async function to execute while the lock is held
 * @param options Lock configuration (ttl and renewal interval)
 * @returns The result of the action
 */
export async function withLock<T>(
    lockKey: string,
    action: () => Promise<T>,
    options: LockOptions = {}
): Promise<T> {
    const { ttl = 300 } = options;
    const renewalInterval = options.renewalInterval || Math.floor(ttl / 2);

    const locked = await kv.setNx(lockKey, "1", ttl);
    if (!locked) {
        console.log(`[Lock] ${lockKey} is already locked by another execution. Throwing to trigger upstream retry.`);
        throw new Error("LOCKED_CONCURRENT_EXECUTION");
    }

    // Start renewal heartbeat
    const intervalId = setInterval(async () => {
        try {
            const renewed = await kv.expire(lockKey, ttl);
            if (!renewed) {
                console.warn(`[Lock] Failed to renew lock ${lockKey}. It may have expired or been deleted.`);
            }
        } catch (error) {
            console.error(`[Lock] Error renewing lock ${lockKey}:`, error);
        }
    }, renewalInterval * 1000);

    try {
        return await action();
    } finally {
        clearInterval(intervalId);
        await kv.delete(lockKey).catch(e => console.error(`[Lock] Failed to release lock ${lockKey}:`, e));
    }
}
