import { registerTaskHandler } from "@/infra/jobs/registry";
import { CoverJobHandler } from "@/services/job_handlers/cover_job_handler";
import { PostProcessHandler } from "@/services/job_handlers/post_process_handler";
import { AiEnrichHandler } from "@/services/job_handlers/ai_enrich_handler";
import { AvatarCopyHandler } from "@/services/job_handlers/avatar_copy_handler";
import { AsyncTaskType } from "@/db/schema";

let initialized = false;

/**
 * Initializes and registers all application JobHandlers.
 * Should be invoked during server startup.
 */
export function initJobHandlers() {
    if (initialized) return;
    initialized = true;

    registerTaskHandler(AsyncTaskType.COVER_RECONCILE, CoverJobHandler);
    registerTaskHandler(AsyncTaskType.COVER_BATCH, CoverJobHandler);
    registerTaskHandler(AsyncTaskType.POST_PROCESS, PostProcessHandler);
    registerTaskHandler(AsyncTaskType.AI_ENRICH, AiEnrichHandler);
    registerTaskHandler(AsyncTaskType.AVATAR_COPY, AvatarCopyHandler);
}
