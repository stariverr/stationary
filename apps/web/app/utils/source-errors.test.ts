import { describe, expect, test } from "bun:test";
import { canRetry, isRetryableKind, suggestedAction, syncDisplay } from "./source-errors";

describe("source errors", () => {
    test("only network and server errors can be retried", () => {
        expect(isRetryableKind("NETWORK")).toBe(true);
        expect(isRetryableKind("INTERNAL")).toBe(true);
        expect(isRetryableKind("SOURCE_UNAVAILABLE")).toBe(false);
        expect(isRetryableKind("UNREADABLE")).toBe(false);
        expect(isRetryableKind("KIND_MISMATCH")).toBe(false);
        expect(isRetryableKind(null)).toBe(false);
    });

    test("a source still syncing with an error is being retried", () => {
        expect(syncDisplay("PENDING", null)).toBe("pending");
        expect(syncDisplay("IN_PROGRESS", null)).toBe("syncing");
        expect(syncDisplay("PENDING", "NETWORK")).toBe("retrying");
        expect(syncDisplay("IN_PROGRESS", "INTERNAL")).toBe("retrying");
        expect(syncDisplay("FAILED", "UNREADABLE")).toBe("failed");
        expect(syncDisplay("COMPLETED", null)).toBe("completed");
        expect(syncDisplay(undefined, null)).toBe("completed");
    });

    test("a retry is offered only for a failure it can get past", () => {
        expect(canRetry("FAILED", "NETWORK")).toBe(true);
        expect(canRetry("FAILED", "SOURCE_UNAVAILABLE")).toBe(false);
        expect(canRetry("PENDING", "NETWORK")).toBe(false);
    });

    test("each kind has its own fix", () => {
        expect(suggestedAction("NETWORK")).toBe("retry");
        expect(suggestedAction("INTERNAL")).toBe("retry");
        expect(suggestedAction("SOURCE_UNAVAILABLE")).toBe("reshare");
        expect(suggestedAction("UNREADABLE")).toBe("replace");
        expect(suggestedAction("KIND_MISMATCH")).toBe("change_kind");
    });
});
