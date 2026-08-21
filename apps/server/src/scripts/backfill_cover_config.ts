import { db } from "@/global/db";
import { Library, DeleteStatus, AsyncTaskType } from "@/db/schema";
import { eq } from "drizzle-orm";

import { Quality } from "@/lib/types";

import { JobManager } from "@/infra/jobs/manager";
import { initJobHandlers } from "@/services/job_handlers";

export async function backfillCoverConfig() {
    console.log("[MIGRATION] Starting backfill of Library cover configuration...");

    const libraries = await db.select().from(Library).where(eq(Library.delete_status, DeleteStatus.ACTIVE));

    let updatedCount = 0;
    const now = Temporal.Now.instant();

    for (const lib of libraries) {
        const defaultQualities = [Quality.LOW, Quality.MEDIUM];
        const currentQualities = lib.cover_qualities as Quality[] | undefined;

        if (!currentQualities || currentQualities.length === 0) {
            await db
                .update(Library)
                .set({
                    cover_qualities: defaultQualities,
                    cover_config_version: 1,
                    update_time: now,
                })
                .where(eq(Library.id, lib.id));

            initJobHandlers();
            await JobManager.createTask({
                type: AsyncTaskType.COVER_RECONCILE,
                libraryId: lib.id,
                configVersion: 1,
            });

            updatedCount++;
        }
    }

    console.log(`[MIGRATION] Backfill complete. Updated ${updatedCount} libraries.`);
}

if (import.meta.main) {
    backfillCoverConfig()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error("[MIGRATION] Backfill failed:", err);
            process.exit(1);
        });
}
