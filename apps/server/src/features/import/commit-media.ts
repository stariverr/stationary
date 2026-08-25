import { and, eq } from "drizzle-orm";
import { DraftFile, DraftFileStatus, File as DbFile } from "@/db/schema";
import { db } from "@/global/db";
import { DraftFileUnavailableError } from "./draft-file";
import { validateDraftMediaGroups, validateDraftTrackFileTypes } from "@/lib/validation/media-composition";
import { createMediaFromDraft } from "@/features/media/create-from-draft";
import { ImportAuth, assertLibraryAccess } from "./access";
import { ImportError } from "./errors";
import type { CommitMediaInput } from "./schema";

export async function commitMedia(input: CommitMediaInput, auth: ImportAuth) {
    await assertLibraryAccess(input.library_id, auth);

    const compositionError = validateDraftMediaGroups(input.media_drafts);
    if (compositionError) {
        throw new ImportError("INVALID_PARAMETER", compositionError);
    }

    const draftIds = input.media_drafts.flatMap((group) => group.tracks.map((track) => track.draft_file_id));
    const draftRows = await db
        .select({ draft: DraftFile, file: DbFile })
        .from(DraftFile)
        .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
        .where(and(eq(DraftFile.library_id, input.library_id), eq(DraftFile.status, DraftFileStatus.DRAFT)));

    const activeDraftMap = new Map(
        draftRows.map(({ draft, file }) => [
            draft.id,
            {
                name: draft.original_name,
                mime_type: file.mime_type,
            },
        ]),
    );

    for (const draftId of draftIds) {
        if (!activeDraftMap.has(draftId)) {
            throw new ImportError("INVALID_PARAMETER", `Draft file ${draftId} is invalid or already consumed`);
        }
    }

    const fileTypeError = validateDraftTrackFileTypes(input.media_drafts, activeDraftMap);
    if (fileTypeError) {
        throw new ImportError("INVALID_PARAMETER", fileTypeError);
    }

    const mediaIds: string[] = [];

    try {
        await db.transaction(async (tx) => {
            const now = Temporal.Now.instant();

            for (const group of input.media_drafts) {
                const mediaId = await createMediaFromDraft({
                    tx,
                    libraryId: input.library_id,
                    draft: group,
                    sortOrder: 0,
                    now,
                });
                mediaIds.push(mediaId);
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
