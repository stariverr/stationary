import { registerTaskHandler } from "@/infra/jobs/registry";
import { AiEnrichHandler } from "@/features/ai/jobs/enrich-handler";
import { AsyncTaskType } from "@/db/schema";

let initialized = false;

/**
 * Registers the handlers of the task engine, which runs AI enrichment only. Downloads, avatars and covers run on
 * the reconcile queue (infra/queue).
 */
export function initJobHandlers() {
    if (initialized) return;
    initialized = true;

    registerTaskHandler(AsyncTaskType.AI_ENRICH, AiEnrichHandler);
}
