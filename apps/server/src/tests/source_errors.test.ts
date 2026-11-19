import { describe, expect, test } from "bun:test";
import { SourceErrorKind, SyncStatus } from "@/db/schema";
import { classifySourceError, SourceTransferError } from "@/features/ingest/source-errors";
import { ProbeRejectedError } from "@/features/media/probe";
import { NO_SOURCE_ERROR, refreshSource } from "@/features/media/source-rows";
import { DownloadStatusError } from "@/lib/utils/media";

describe("classifySourceError", () => {
    test("a URL the platform refuses is final", () => {
        for (const status of [400, 403, 404, 410]) {
            expect(classifySourceError(new DownloadStatusError(status, "https://a"))).toMatchObject({
                kind: SourceErrorKind.SOURCE_UNAVAILABLE,
                retryable: false,
            });
        }
    });

    test("other statuses and broken transfers are network errors, retried", () => {
        for (const status of [401, 408, 429, 500, 503]) {
            expect(classifySourceError(new DownloadStatusError(status, "https://a"))).toMatchObject({ kind: SourceErrorKind.NETWORK, retryable: true });
        }
        expect(classifySourceError(new SourceTransferError(new Error("socket hang up")))).toEqual({
            kind: SourceErrorKind.NETWORK,
            retryable: true,
            message: "socket hang up",
        });
    });

    test("a file the tools cannot read is final", () => {
        expect(classifySourceError(new ProbeRejectedError("not a media file"))).toMatchObject({ kind: SourceErrorKind.UNREADABLE, retryable: false });
    });

    test("anything else is internal, retried", () => {
        expect(classifySourceError(new Error("deadlock detected"))).toEqual({
            kind: SourceErrorKind.INTERNAL,
            retryable: true,
            message: "deadlock detected",
        });
    });
});

describe("refreshSource", () => {
    const url = "https://cdn.test/a.jpg";
    const resigned = "https://cdn.test/a.jpg?sig=2";

    test("a new URL starts a source not yet downloaded over, voiding the old URL's error", () => {
        for (const status of [SyncStatus.PENDING, SyncStatus.IN_PROGRESS, SyncStatus.FAILED]) {
            expect(refreshSource({ status, source_url: url }, resigned)).toEqual({
                values: { source_url: resigned, status: SyncStatus.PENDING, ...NO_SOURCE_ERROR },
                pending: true,
            });
        }
    });

    test("a new URL only replaces the URL of a downloaded source", () => {
        expect(refreshSource({ status: SyncStatus.COMPLETED, source_url: url }, resigned)).toEqual({ values: { source_url: resigned }, pending: false });
    });

    test("the same URL leaves a failed source failed and a waiting one waiting", () => {
        expect(refreshSource({ status: SyncStatus.FAILED, source_url: url }, url)).toEqual({ values: {}, pending: false });
        expect(refreshSource({ status: SyncStatus.COMPLETED, source_url: url }, url)).toEqual({ values: {}, pending: false });
        expect(refreshSource({ status: SyncStatus.PENDING, source_url: url }, url)).toEqual({ values: {}, pending: true });
        expect(refreshSource({ status: SyncStatus.IN_PROGRESS, source_url: url }, url)).toEqual({ values: {}, pending: true });
    });
});
