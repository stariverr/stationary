import type { Transaction } from "@/global/db";
import type { PipelineName } from "@/infra/queue/pipelines";

export interface ReconcileContext {
    readonly subjectId: string;
    readonly libraryId: string;
    /** Failed attempts before this run. */
    readonly attempts: number;
    /** Aborted when the lease is lost or the worker shuts down. */
    readonly signal: AbortSignal;
    /** Must be the first statement of every transaction that writes results; throws LeaseLostError if the lease is gone. */
    readonly fence: (tx: Transaction) => Promise<void>;
}

export type ReconcileResult =
    /** The subject matches its desired state (or nothing could be done yet). */
    | { readonly kind: "done" }
    /** Not retryable with the same input; recorded on the result rows at once. */
    | { readonly kind: "failed"; readonly error: string };

export interface ScanPage {
    /** Subjects of this page that need the pipeline; enqueued at backfill priority. */
    readonly subjectIds: readonly string[];
    /** Id of the last subject paged through, or null when the library is done. */
    readonly nextCursor: string | null;
}

/** A failure recorded on a subject's result rows that still applies to its current input. */
export interface PipelineFailure {
    readonly subjectId: string;
    /** What the subject is called in the UI (media title, author nickname). */
    readonly label: string | null;
    readonly error: string;
    readonly time: Temporal.Instant | null;
}

/**
 * Implementation of a declared pipeline. `reconcile` reads the current state and does only the difference, so it can
 * run any number of times. A thrown error is retried with backoff until `maxAttempts`, then `recordFailure` stores it
 * on the result rows together with the input it failed on.
 */
export interface PipelineHandler {
    readonly maxAttempts?: number;
    reconcile(ctx: ReconcileContext): Promise<ReconcileResult>;
    recordFailure(tx: Transaction, subjectId: string, error: string): Promise<void>;
    /**
     * One page of a library scan, in subject id order after `cursor`. Leaves out subjects whose last failure was on
     * their current input, so periodic scans do not retry failures forever.
     */
    scanPage(libraryId: string, cursor: string | null, limit: number): Promise<ScanPage>;
    /** Number of current failures per library id (libraries without failures may be missing). */
    countFailures(libraryIds: readonly string[]): Promise<Map<string, number>>;
    /** Current failures of one library, most recent first; all of them when `limit` is omitted. */
    listFailures(libraryId: string, limit?: number): Promise<PipelineFailure[]>;
}

export type PipelineHandlers = Record<PipelineName, PipelineHandler>;
