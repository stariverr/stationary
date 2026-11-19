/**
 * Classifies why the download of a source failed (docs/failure_handling.zh-Hans.md, 5). Only errors known to be about
 * the input are final; anything uncertain is retried.
 */
import { SourceErrorKind, type OriginalKind } from "@/db/schema";
import { ProbeRejectedError } from "@/features/media/probe";
import { getErrorMessage } from "@/lib/utils/error";
import { DownloadStatusError } from "@/lib/utils/media";

/** Statuses that say the URL itself is refused: malformed, gone, or (most often) past its signature's expiry. */
const UNAVAILABLE_STATUSES = new Set([400, 403, 404, 410]);

/** The source could not be reached or broke off mid-transfer: the connection or a timeout. Storage errors are not. */
export class SourceTransferError extends Error {
    constructor(cause: unknown) {
        super(getErrorMessage(cause), { cause });
        this.name = "SourceTransferError";
    }
}

/** The probed original is not the kind the import declared (docs/failure_handling.zh-Hans.md, 7). */
export class KindMismatchError extends Error {
    constructor(declared: OriginalKind, probed: OriginalKind) {
        super(`Declared as ${declared}, but the file holds ${probed}`);
        this.name = "KindMismatchError";
    }
}

export interface SourceError {
    readonly kind: SourceErrorKind;
    /** Whether a later attempt on the same URL may pass; a final error ends the source FAILED at once. */
    readonly retryable: boolean;
    readonly message: string;
}

export function classifySourceError(error: unknown): SourceError {
    const message = getErrorMessage(error);
    if (error instanceof DownloadStatusError) {
        return UNAVAILABLE_STATUSES.has(error.status)
            ? { kind: SourceErrorKind.SOURCE_UNAVAILABLE, retryable: false, message }
            : { kind: SourceErrorKind.NETWORK, retryable: true, message };
    }
    if (error instanceof ProbeRejectedError) return { kind: SourceErrorKind.UNREADABLE, retryable: false, message };
    if (error instanceof KindMismatchError) return { kind: SourceErrorKind.KIND_MISMATCH, retryable: false, message };
    if (error instanceof SourceTransferError) return { kind: SourceErrorKind.NETWORK, retryable: true, message };
    return { kind: SourceErrorKind.INTERNAL, retryable: true, message };
}
