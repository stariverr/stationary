export type PipelineName = "download" | "avatar" | "preview" | "ai.describe" | "ai.index" | "ai.text" | "ai.image";

/** One pipeline in one library, as returned by GET /jobs/pipelines. */
export interface PipelineStatus {
    pipeline: PipelineName;
    /** Subjects waiting or running. */
    queued: number;
    running: number;
    /** Subjects waiting to retry after a failed attempt. */
    retrying: number;
    /** Subjects whose failure was recorded and still applies. */
    failed: number;
    /** A library scan is under way, so `queued` may still grow. */
    scanning: boolean;
    /** How long the oldest queued row has been waiting. */
    oldest_seconds: number;
    /** How long the provider of this pipeline stays out of reach; 0 when it can be called. */
    blocked_seconds: number;
}

/** GET /jobs/pipelines for one library. */
export interface LibraryPipelines {
    /** The library's background work is on hold: nothing new starts until it is resumed. */
    paused: boolean;
    pipelines: PipelineStatus[];
}

export interface PipelineFailure {
    subject_id: string;
    label: string | null;
    error: string;
    time: string | null;
    /** The post of a media subject. */
    post: { id: string; url: string | null } | null;
}

/** Failures of one kind, as GET /jobs/pipelines/:library_id/:pipeline/failures groups them, the largest first. */
export interface PipelineFailureGroup {
    /** A SourceErrorKind for `download`; null for a pipeline that does not classify its failures. */
    kind: string | null;
    count: number;
    /** The most recent ones. */
    items: PipelineFailure[];
}
