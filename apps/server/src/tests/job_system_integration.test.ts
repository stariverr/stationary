import { describe, expect, test } from "bun:test";
import { AsyncTaskStatus, AsyncTaskType } from "@/db/schema";
import { getTaskHandler } from "@/infra/jobs/registry";
import {
    MAX_LOCK_CONTENTION_DELAY_SECONDS,
    MAX_RETRY_DELAY_SECONDS,
    MIN_LOCK_CONTENTION_DELAY_SECONDS,
    lockContentionDelaySeconds,
    requirePositiveInteger,
    retryDelaySeconds,
    taskStatusAfterDiscovery,
    terminalTaskStatus,
} from "@/infra/jobs/policy";
import { createIdempotencyKey } from "@/lib/utils/hash";
import { LockAcquisitionError, isLockAcquisitionError } from "@/lib/utils/lock";
import { initJobHandlers } from "@/services/job_handlers";

describe("Job engine contracts", () => {
    test("all persisted task types have a registered handler", () => {
        initJobHandlers();

        for (const taskType of Object.values(AsyncTaskType)) {
            expect(getTaskHandler(taskType), `Missing handler for ${taskType}`).toBeDefined();
        }
    });

    test("a completed discovery always makes units dispatchable", () => {
        expect(taskStatusAfterDiscovery(AsyncTaskStatus.DISCOVERING, false)).toBe(AsyncTaskStatus.DISCOVERING);
        expect(taskStatusAfterDiscovery(AsyncTaskStatus.DISCOVERING, true)).toBe(AsyncTaskStatus.RUNNING);
        expect(taskStatusAfterDiscovery(AsyncTaskStatus.RUNNING, false)).toBe(AsyncTaskStatus.RUNNING);
    });

    test("task finalization depends on discovery and all unit counters", () => {
        expect(
            terminalTaskStatus({
                discovery_complete: false,
                total_units: 0,
                succeeded_units: 0,
                failed_units: 0,
                cancelled_units: 0,
            }),
        ).toBeNull();
        expect(
            terminalTaskStatus({
                discovery_complete: true,
                total_units: 2,
                succeeded_units: 1,
                failed_units: 0,
                cancelled_units: 0,
            }),
        ).toBeNull();
        expect(
            terminalTaskStatus({
                discovery_complete: true,
                total_units: 2,
                succeeded_units: 2,
                failed_units: 0,
                cancelled_units: 0,
            }),
        ).toBe(AsyncTaskStatus.COMPLETED);
        expect(
            terminalTaskStatus({
                discovery_complete: true,
                total_units: 2,
                succeeded_units: 1,
                failed_units: 1,
                cancelled_units: 0,
            }),
        ).toBe(AsyncTaskStatus.FAILED);
        expect(() =>
            terminalTaskStatus({
                discovery_complete: true,
                total_units: 1,
                succeeded_units: 1,
                failed_units: 1,
                cancelled_units: 0,
            }),
        ).toThrow("processed units exceeds total");
    });

    test("retry policy uses bounded exponential backoff with jitter", () => {
        expect(retryDelaySeconds(1, () => 0)).toBe(4);
        expect(retryDelaySeconds(1, () => 1)).toBe(6);
        expect(retryDelaySeconds(20, () => 1)).toBe(MAX_RETRY_DELAY_SECONDS);
        expect(lockContentionDelaySeconds(() => 0)).toBe(MIN_LOCK_CONTENTION_DELAY_SECONDS);
        expect(lockContentionDelaySeconds(() => 1)).toBe(MAX_LOCK_CONTENTION_DELAY_SECONDS);
        expect(() => requirePositiveInteger(0, "attempts")).toThrow("attempts must be a positive integer");
    });

    test("idempotency hashing is stable across object key order", () => {
        const first = createIdempotencyKey("post", { postId: "p1", options: { force: true, quality: "high" } });
        const reordered = createIdempotencyKey("post", { options: { quality: "high", force: true }, postId: "p1" });
        const different = createIdempotencyKey("post", { postId: "p2", options: { force: true, quality: "high" } });

        expect(first).toBe(reordered);
        expect(first).not.toBe(different);
    });

    test("LockAcquisitionError is identified as lock contention", () => {
        const lockErr = new LockAcquisitionError("lock:media:123");
        expect(isLockAcquisitionError(lockErr)).toBeTrue();
        expect(lockErr.code).toBe("LOCKED_CONCURRENT_EXECUTION");
        expect(isLockAcquisitionError({ code: "LOCKED_CONCURRENT_EXECUTION" })).toBeTrue();
        expect(isLockAcquisitionError(new Error("LOCKED_CONCURRENT_EXECUTION"))).toBeFalse();
        expect(isLockAcquisitionError(new Error("Random DB failure"))).toBeFalse();
    });
});
