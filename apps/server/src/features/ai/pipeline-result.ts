import { throttledDelaySeconds } from "@/infra/queue/policy";
import type { ReconcileResult } from "@/infra/queue/types";
import { classifyAiError, getFailureCategory, getSafeAiErrorMessage } from "./errors";

/**
 * What an error of an AI request means for the queue row: a provider at its rate limit postpones the run without
 * using an attempt, an error about the input rejects it, and everything else, unknown errors included, is retried.
 */
export function aiErrorResult(error: unknown): ReconcileResult {
    const classification = classifyAiError(error);
    if (classification.kind === "THROTTLED") {
        return { kind: "deferred", delaySeconds: throttledDelaySeconds((classification.retryAfterMs ?? 0) / 1000) };
    }
    // Shutting down: the run is retried like any interrupted run.
    if (classification.kind === "CANCELLED") throw error;

    const result = { error: getSafeAiErrorMessage(error), errorKind: classification.kind };
    return getFailureCategory(classification.kind) === "input" ? { kind: "rejected", ...result } : { kind: "retry", ...result };
}
