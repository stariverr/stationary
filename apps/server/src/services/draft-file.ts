import { and, eq } from "drizzle-orm";
import { DraftFile, DraftFileStatus, File as DbFile, DeleteStatus } from "@/db/schema";
import type { Transaction } from "@/global/db";
import { nowDbTimestamp } from "@/lib/utils/time";

export class DraftFileUnavailableError extends Error {
    constructor(public readonly draftFileId: string) {
        super(`Draft file ${draftFileId} is invalid or already consumed`);
        this.name = "DraftFileUnavailableError";
    }
}

export async function consumeDraftFile(tx: Transaction, draftFileId: string, libraryId: string): Promise<string> {
    const [updatedDraft] = await tx
        .delete(DraftFile)
        .where(
            and(
                eq(DraftFile.id, draftFileId),
                eq(DraftFile.library_id, libraryId),
                eq(DraftFile.status, DraftFileStatus.DRAFT),
            ),
        )
        .returning({ file_id: DraftFile.file_id });

    if (!updatedDraft) {
        throw new DraftFileUnavailableError(draftFileId);
    }

    return updatedDraft.file_id;
}

export async function deleteDraftFile(tx: Transaction, draftFileId: string, libraryId: string): Promise<boolean> {
    const now = nowDbTimestamp();
    const [updatedDraft] = await tx
        .update(DraftFile)
        .set({
            status: DraftFileStatus.DELETED,
            update_time: now,
        })
        .where(and(eq(DraftFile.id, draftFileId), eq(DraftFile.library_id, libraryId), eq(DraftFile.status, DraftFileStatus.DRAFT)))
        .returning({ file_id: DraftFile.file_id });

    if (!updatedDraft) return false;

    await tx
        .update(DbFile)
        .set({
            delete_status: DeleteStatus.DELETED,
            delete_time: now,
        })
        .where(eq(DbFile.id, updatedDraft.file_id));

    return true;
}
