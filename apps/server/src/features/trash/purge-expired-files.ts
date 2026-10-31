import { and, asc, eq, gt, lt } from "drizzle-orm";
import { DeleteStatus, File as DbFile } from "@/db/schema";
import { db } from "@/global/db";
import { s3 } from "@/global/s3";
import { getErrorMessage } from "@/lib/utils/error";

const RETENTION_HOURS = 30 * 24;
const BATCH_SIZE = 500;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let purgeInterval: ReturnType<typeof setInterval> | null = null;

export interface PurgeExpiredFilesResult {
    purgedCount: number;
    failedCount: number;
    errors: Array<{ fileId: string; error: string }>;
}

export async function purgeExpiredFiles(): Promise<PurgeExpiredFilesResult> {
    const cutoff = Temporal.Now.instant().subtract({ hours: RETENTION_HOURS });

    let purgedCount = 0;
    let failedCount = 0;
    const errors: PurgeExpiredFilesResult["errors"] = [];
    // Walk by id so a file that fails stays behind for the next run instead of being refetched forever.
    let lastId: string | undefined;

    while (true) {
        const expiredFiles = await db
            .select()
            .from(DbFile)
            .where(
                and(
                    eq(DbFile.delete_status, DeleteStatus.DELETED),
                    lt(DbFile.delete_time, cutoff),
                    lastId ? gt(DbFile.id, lastId) : undefined,
                ),
            )
            .orderBy(asc(DbFile.id))
            .limit(BATCH_SIZE);

        if (expiredFiles.length === 0) break;

        for (const file of expiredFiles) {
            try {
                try {
                    await s3.delete(file.path, { bucket: file.bucket });
                } catch (s3Err: any) {
                    if (s3Err.name !== "NotFound" && s3Err.name !== "NoSuchKey") {
                        throw s3Err;
                    }
                }

                await db.delete(DbFile).where(eq(DbFile.id, file.id));
                purgedCount++;
            } catch (e) {
                failedCount++;
                errors.push({ fileId: file.id, error: getErrorMessage(e) });
            }
        }

        lastId = expiredFiles[expiredFiles.length - 1]!.id;
    }

    return { purgedCount, failedCount, errors };
}

async function runScheduledPurge(): Promise<void> {
    try {
        const { purgedCount, failedCount, errors } = await purgeExpiredFiles();
        console.log(`[FilePurge] Purged ${purgedCount} expired files, ${failedCount} failed.`);
        if (failedCount > 0) {
            console.error(`[FilePurge] First failure: file ${errors[0]!.fileId}: ${errors[0]!.error}`);
        }
    } catch (error) {
        console.error(`[FilePurge] Scheduled purge failed: ${getErrorMessage(error)}`);
    }
}

// Runs on start as well as daily: a restart resets the timer, so frequent deploys would otherwise starve the purge.
export function startFilePurgeSchedule(): void {
    if (purgeInterval) return;

    void runScheduledPurge();
    purgeInterval = setInterval(() => void runScheduledPurge(), PURGE_INTERVAL_MS);
    purgeInterval.unref?.();
}

export function stopFilePurgeSchedule(): void {
    if (!purgeInterval) return;
    clearInterval(purgeInterval);
    purgeInterval = null;
}
