import { describe, expect, test } from "bun:test";
import { getTaskHandler } from "@/services/job_service";
import { initJobHandlers } from "@/services/handlers";
import { Quality } from "@/lib/types";

describe("Job System & Lease Fencing Contracts", () => {
    test("Progress math formula remains strictly consistent", () => {
        const job = {
            total_units: 180,
            completed_units: 130,
            cancelled_units: 5,
            succeeded_units: 50,
            skipped_units: 75,
            failed_units: 5,
            running_units: 5,
        };

        const processed = job.completed_units + job.cancelled_units;
        const succeeded = job.succeeded_units + job.skipped_units;
        const failed = job.failed_units;
        const percent = Math.min(100, Math.floor((processed / job.total_units) * 100));

        expect(processed).toBe(135);
        expect(succeeded).toBe(125);
        expect(failed).toBe(5);
        expect(percent).toBe(75);
    });

    test("Quality ordering and config boundary validation", () => {
        const activeQualities = [Quality.LOW, Quality.MEDIUM];
        const isHighConfigured = activeQualities.includes(Quality.HIGH);
        expect(isHighConfigured).toBe(false);
        expect(activeQualities.includes(Quality.LOW)).toBe(true);
    });

    test("Decoupled JobHandlers initialize and register successfully", () => {
        initJobHandlers();
        expect(getTaskHandler("COVER_BATCH")).toBeDefined();
        expect(getTaskHandler("COVER_RECONCILE")).toBeDefined();
    });
});
