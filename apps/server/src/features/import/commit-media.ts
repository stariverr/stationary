import { db } from "@/global/db";
import { DraftFileUnavailableError } from "./draft-file";
import { createMediaFromDraft, DraftContentError, prepareDrafts } from "@/features/media/create-from-draft";
import type { LibraryAuth } from "@/features/library/access";
import { assertLibraryAccess } from "./access";
import { ImportError } from "./errors";
import type { CommitMediaInput } from "./schema";

export async function commitMedia(input: CommitMediaInput, auth: LibraryAuth) {
    await assertLibraryAccess(input.library_id, auth);

    let prepared;
    try {
        prepared = await prepareDrafts(input.library_id, input.media_drafts);
    } catch (error) {
        if (error instanceof DraftContentError) throw new ImportError("INVALID_PARAMETER", error.message);
        throw error;
    }

    const mediaIds: string[] = [];
    try {
        await db.transaction(async (tx) => {
            const now = Temporal.Now.instant();
            for (const draft of prepared) {
                mediaIds.push(await createMediaFromDraft({ tx, libraryId: input.library_id, prepared: draft, sortOrder: 0, now }));
            }
        });
    } catch (error) {
        if (error instanceof DraftFileUnavailableError) {
            throw new ImportError("CONFLICT", error.message);
        }
        throw error;
    }

    return { mediaIds };
}
