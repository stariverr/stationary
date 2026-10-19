import { describe, expect, it } from "bun:test";
import { assessBuildingSpace, type BuildProgress } from "@/features/ai/embedding-spaces";

const drained: BuildProgress = { backfillRunning: false, total: 100, ready: 100, pending: 0, failed: 0, activeReady: 100 };

describe("assessBuildingSpace", () => {
    it("waits while the backfill runs or vectors are queued", () => {
        expect(assessBuildingSpace({ ...drained, backfillRunning: true })).toEqual({ state: "waiting" });
        expect(assessBuildingSpace({ ...drained, pending: 1 })).toEqual({ state: "waiting" });
    });

    it("promotes a space that covers the library", () => {
        expect(assessBuildingSpace(drained)).toEqual({ state: "ready" });
        expect(assessBuildingSpace({ ...drained, ready: 96, failed: 2 })).toEqual({ state: "ready" });
        // A library without an active space, or a broken active space, has nothing to fall short of.
        expect(assessBuildingSpace({ ...drained, ready: 0, activeReady: 0 })).toEqual({ state: "ready" });
    });

    it("holds back a space whose model failed most inputs", () => {
        // A wrong key fails every row: the queue drains, but nothing is usable.
        expect(assessBuildingSpace({ ...drained, ready: 0, failed: 100 })).toEqual({ state: "blocked", reason: "too_many_failures" });
        expect(assessBuildingSpace({ ...drained, ready: 90, failed: 10 })).toEqual({ state: "blocked", reason: "too_many_failures" });
    });

    it("holds back a space that covers clearly less than the active one", () => {
        // e.g. a cancelled backfill.
        expect(assessBuildingSpace({ ...drained, ready: 40 })).toEqual({ state: "blocked", reason: "low_coverage" });
    });
});
