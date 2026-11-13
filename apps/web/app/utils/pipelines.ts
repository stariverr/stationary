import type { PipelineName, PipelineStatus } from "@/types/pipeline";

/** How the jobs page groups pipelines, each group in the order its work flows. */
export const PIPELINE_GROUPS: readonly { key: "media" | "ai"; pipelines: readonly PipelineName[] }[] = [
    { key: "media", pipelines: ["download", "cover", "avatar"] },
    { key: "ai", pipelines: ["ai.describe", "ai.index", "ai.text", "ai.image"] },
];

/** The one state a pipeline is shown in, most pressing first. */
export type PipelineState = "blocked" | "failed" | "paused" | "active" | "idle";

export function hasWork(status: PipelineStatus): boolean {
    return status.scanning || status.queued > 0;
}

export function pipelineState(status: PipelineStatus, paused: boolean): PipelineState {
    if (status.blocked_seconds > 0) return "blocked";
    if (status.failed > 0) return "failed";
    if (hasWork(status)) return paused ? "paused" : "active";
    return "idle";
}

export const PIPELINE_STATE_DOT: Record<PipelineState, string> = {
    blocked: "bg-amber-500",
    failed: "bg-red-500",
    paused: "bg-zinc-400",
    active: "bg-sky-500",
    idle: "bg-zinc-200",
};

/** Waiting work as the table and inspector show it: the queue count includes subjects being processed. */
export function waitingCount(status: PipelineStatus): number {
    return Math.max(0, status.queued - status.running);
}

export function formatWait(seconds: number, locale: string): string {
    const hours = seconds / 3600;
    if (hours >= 1) return new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long", maximumFractionDigits: 0 }).format(Math.floor(hours));
    return new Intl.NumberFormat(locale, { style: "unit", unit: "minute", unitDisplay: "long" }).format(Math.max(1, Math.ceil(seconds / 60)));
}
