export type PipelineName = "download" | "avatar" | "cover" | "ai.describe" | "ai.index" | "ai.text" | "ai.image";

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
}

export interface PipelineFailure {
    subject_id: string;
    label: string | null;
    error: string;
    time: string | null;
}
