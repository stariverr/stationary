import { kv } from "@/global/kv";

export const LOCK_ACQUISITION_ERROR_CODE = "LOCKED_CONCURRENT_EXECUTION" as const;

export interface LockAcquisitionFailure {
    readonly code: typeof LOCK_ACQUISITION_ERROR_CODE;
}

export class LockAcquisitionError extends Error {
    public readonly code = LOCK_ACQUISITION_ERROR_CODE;
    public readonly lockKey: string;

    constructor(lockKey: string) {
        super(`LOCKED_CONCURRENT_EXECUTION: Lock key '${lockKey}' is held by another execution.`);
        this.name = "LockAcquisitionError";
        this.lockKey = lockKey;
    }
}

export function isLockAcquisitionError(error: unknown): error is LockAcquisitionFailure {
    if (error instanceof LockAcquisitionError) return true;
    return typeof error === "object" && error !== null && (error as { code?: unknown }).code === LOCK_ACQUISITION_ERROR_CODE;
}

interface LockOptions {
    /** Lock expiration time in seconds */
    ttl?: number;
    /** How often to renew the lock while executing, in seconds. Default is ttl / 2 */
    renewalInterval?: number;
    /** Cancels the protected action when the caller loses its task lease. */
    signal?: AbortSignal;
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
export async function withLock<T>(lockKey: string, action: (signal: AbortSignal) => Promise<T>, options: LockOptions = {}): Promise<T> {
    const { ttl = 300 } = options;
    const renewalInterval = options.renewalInterval ?? Math.floor(ttl / 2);
    if (!Number.isInteger(ttl) || ttl <= 0) throw new RangeError("Lock TTL must be a positive integer");
    if (!Number.isInteger(renewalInterval) || renewalInterval <= 0 || renewalInterval >= ttl) {
        throw new RangeError("Lock renewal interval must be a positive integer smaller than the TTL");
    }

    options.signal?.throwIfAborted();
    const ownerToken = crypto.randomUUID();

    const locked = await kv.setNx(lockKey, ownerToken, ttl);
    if (!locked) {
        console.log(`[Lock] ${lockKey} is already locked by another execution. Throwing to trigger upstream retry.`);
        throw new LockAcquisitionError(lockKey);
    }

    const actionController = new AbortController();
    const abortFromCaller = () => actionController.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();

    let renewalInFlight = false;
    const intervalId = setInterval(() => {
        if (renewalInFlight || actionController.signal.aborted) return;
        renewalInFlight = true;

        void kv
            .renewLock(lockKey, ownerToken, ttl)
            .then((renewed) => {
                if (!renewed && !actionController.signal.aborted) {
                    const error = new Error(`Lost ownership of distributed lock '${lockKey}'`);
                    console.warn(`[Lock] ${error.message}`);
                    actionController.abort(error);
                }
            })
            .catch((error: unknown) => {
                console.error(`[Lock] Error renewing lock ${lockKey}:`, error);
                if (!actionController.signal.aborted) actionController.abort(error);
            })
            .finally(() => {
                renewalInFlight = false;
            });
    }, renewalInterval * 1000);
    intervalId.unref?.();

    try {
        actionController.signal.throwIfAborted();
        const result = await action(actionController.signal);
        actionController.signal.throwIfAborted();
        return result;
    } finally {
        clearInterval(intervalId);
        options.signal?.removeEventListener("abort", abortFromCaller);
        await kv
            .releaseLock(lockKey, ownerToken)
            .catch((error: unknown) => console.error(`[Lock] Failed to release lock ${lockKey}:`, error));
    }
}
