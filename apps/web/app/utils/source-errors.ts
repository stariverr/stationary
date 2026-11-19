import type { SourceErrorKind } from "@/types/post";

/**
 * How the views show a download failure (docs/failure_handling.zh-Hans.md, 9.2). The failure lives on the source rows;
 * a media or post carries the main `error_kind` of its sources, which the server picks so that a retryable main kind
 * means every failure under it is retryable. Views word a failure by its kind only, never by parsing `last_error`.
 */

/** Kinds a retry may get past; the others need the post shared again or a fix in the editor. */
const RETRYABLE_KINDS: readonly SourceErrorKind[] = ["NETWORK", "INTERNAL"];

export function isRetryableKind(kind: SourceErrorKind | null | undefined): boolean {
    return kind != null && RETRYABLE_KINDS.includes(kind);
}

/** What a sync status with its error comes down to on screen; `retrying` is a source being tried again after an error. */
export type SyncDisplay = "pending" | "syncing" | "retrying" | "failed" | "completed";

export function syncDisplay(status: string | null | undefined, kind: SourceErrorKind | null | undefined): SyncDisplay {
    if (status === "FAILED") return "failed";
    if (status === "PENDING" || status === "IN_PROGRESS") {
        if (kind) return "retrying";
        return status === "PENDING" ? "pending" : "syncing";
    }
    return "completed";
}

/** A retry is offered only for a failure it can get past; a failure being retried already gets no button. */
export function canRetry(status: string | null | undefined, kind: SourceErrorKind | null | undefined): boolean {
    return status === "FAILED" && isRetryableKind(kind);
}

/** What the user can do about a failure of `kind`. */
export type SourceErrorAction = "retry" | "reshare" | "replace" | "change_kind";

export function suggestedAction(kind: SourceErrorKind): SourceErrorAction {
    switch (kind) {
        case "NETWORK":
        case "INTERNAL":
            return "retry";
        case "SOURCE_UNAVAILABLE":
            return "reshare";
        case "UNREADABLE":
            return "replace";
        case "KIND_MISMATCH":
            return "change_kind";
    }
}
