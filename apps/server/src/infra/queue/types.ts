import type { Transaction } from "@/global/db";
import type { Aspect, PipelineName } from "@/infra/queue/pipelines";

export interface ReconcileContext {
    readonly subjectId: string;
    readonly libraryId: string;
    /** Space row id of a per-space pipeline; null otherwise. */
    readonly space: string | null;
    /**
     * Aborted when the lease is lost, the run is past its deadline or the worker shuts down. A run that does not return
     * soon after keeps running with nothing waiting for it, so everything it awaits has to take this signal.
     */
    readonly signal: AbortSignal;
    /**
     * Call in every transaction that writes results, after those writes and before markChanged. Throws LeaseLostError if
     * the lease is gone, which rolls them back. It comes after them because everyone locks in this order, result rows
     * then queue rows, and because a run has no other reason to hold its queue row while it writes.
     */
    readonly fence: (tx: Transaction) => Promise<void>;
}

export type ReconcileResult =
    /**
     * The subject matches its desired state (or nothing could be done yet). `changed` is reported in the transaction
     * that deletes the queue row, for a run that wrote nothing but may have been waited for.
     */
    | { readonly kind: "done"; readonly changed?: Aspect }
    /** The input itself cannot be processed: recorded at once with the input, and scans skip it until the input changes. */
    | { readonly kind: "rejected"; readonly error: string; readonly errorKind?: string }
    /**
     * May work later (an outage, an unknown error): retried after a backoff. Once the attempts run out the error is
     * recorded without the input, so the next patrol's scan queues the subject again. Same as throwing.
     */
    | { readonly kind: "retry"; readonly error: string; readonly errorKind?: string }
    /** Could not start yet (a provider at its rate limit): runs again after `delaySeconds`, without using an attempt. */
    | { readonly kind: "deferred"; readonly delaySeconds: number };

/** A failure to store on a subject's result rows. */
export interface FailureRecord {
    readonly subjectId: string;
    readonly space: string | null;
    readonly error: string;
    /** Classified kind of the error, when the pipeline classifies its errors. */
    readonly errorKind: string | null;
    /** The input is at fault: store it with the error, so scans skip the subject until it changes. */
    readonly rejected: boolean;
}

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

interface PipelineHandlerBase {
    readonly maxAttempts?: number;
    /** How long a run may take. Past it the run is aborted and counts as a failed attempt. */
    readonly timeoutMs?: number;
    recordFailure(tx: Transaction, failure: FailureRecord): Promise<void>;
    /**
     * One page of a library scan, in subject id order after `cursor`. Leaves out subjects rejected on their current
     * input; other recorded failures stay in, so the patrol retries them.
     */
    scanPage(libraryId: string, cursor: string | null, limit: number, space: string | null): Promise<ScanPage>;
    /** Number of current failures per library id (libraries without failures may be missing). */
    countFailures(libraryIds: readonly string[]): Promise<Map<string, number>>;
    /** Current failures of one library, most recent first; all of them when `limit` is omitted. */
    listFailures(libraryId: string, limit?: number): Promise<PipelineFailure[]>;
    /** How long the provider this pipeline calls in a library stays out of reach, in milliseconds; 0 when it can be called. */
    blockedMs?(libraryId: string): Promise<number>;
    /** Called after a run or a finished scan of a per-space pipeline, to act on the space once its queue drains. */
    settled?(libraryId: string, space: string): Promise<void>;
    /** Periodic upkeep, run with the patrol. */
    patrol?(): Promise<void>;
}

/**
 * Implementation of a declared pipeline that reconciles one subject at a time. `reconcile` reads the current state
 * and does only the difference, so it can run any number of times. A thrown error is retried with backoff until
 * `maxAttempts`, then `recordFailure` stores it on the result rows.
 */
export interface SubjectPipelineHandler extends PipelineHandlerBase {
    reconcile(ctx: ReconcileContext): Promise<ReconcileResult>;
}

export interface BatchContext {
    readonly libraryId: string;
    readonly space: string | null;
    /** The claimed subject the batch starts from. */
    readonly head: string;
    readonly signal: AbortSignal;
    /**
     * Leases up to `limit` more due subjects of the same queue, without waiting for any. A subject whose previous run
     * was interrupted is not batched, as head or as one of these, since running it may take the worker down.
     */
    readonly claimMore: (limit: number) => Promise<string[]>;
    /** As ReconcileContext.fence, for one subject of the batch. */
    readonly fence: (tx: Transaction, subjectId: string) => Promise<void>;
}

/**
 * A pipeline that reconciles several subjects with one provider request. Returns a result per subject of the batch;
 * a thrown error retries all of them. An input error must not be returned for a whole batch: the handler has to find
 * the subject at fault, since rows that fail and retry stay batched.
 */
export interface BatchPipelineHandler extends PipelineHandlerBase {
    reconcileBatch(ctx: BatchContext): Promise<Map<string, ReconcileResult>>;
}

export type PipelineHandler = SubjectPipelineHandler | BatchPipelineHandler;

export type PipelineHandlers = Record<PipelineName, PipelineHandler>;
