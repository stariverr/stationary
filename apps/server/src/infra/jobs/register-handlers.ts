import { registerTaskHandler } from "@/infra/jobs/registry";
import { CoverJobHandler } from "@/features/media/jobs/cover-handler";
import { PostProcessHandler } from "@/features/ingest/jobs/post-process-handler";
import { AiEnrichHandler } from "@/features/ai/jobs/enrich-handler";
import { AvatarCopyHandler } from "@/features/author/jobs/avatar-copy-handler";
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
