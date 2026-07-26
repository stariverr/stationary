import { registerTaskHandler } from "@/services/job_service";
import { CoverJobHandler } from "@/services/handlers/cover_job_handler";

let initialized = false;

/**
 * Initializes and registers all application JobHandlers.
 * Should be invoked during server startup.
 */
export function initJobHandlers() {
    if (initialized) return;
    initialized = true;

    registerTaskHandler("COVER_RECONCILE", CoverJobHandler);
    registerTaskHandler("COVER_BATCH", CoverJobHandler);
}
