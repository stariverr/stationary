import { v7 as uuidv7 } from "uuid";
import { and, eq, inArray } from "drizzle-orm";
import { DraftFile, DraftFileStatus, File as DbFile, Media, PostSource, SyncStatus } from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { consumeDraftFile } from "@/features/import/draft-file";
import { draftFileIds, validateDraftMediaGroups, type MediaDraft } from "@/lib/validation/media-composition";
import { convertToVtt, insertUploadedCaption, storeVtt } from "./captions";
import { CoverService } from "./cover";
import { markMediaMetaChanged } from "./meta-changes";
import { compositionError, insertUploadedOriginal, kindOfProbe } from "./originals";
import { probeOriginal, ProbeRejectedError, type OriginalProbe } from "./probe";
import { replaceMediaTagsTx } from "./tags";

/** A draft that cannot become a media: a bad structure, a file that cannot be probed, or a wrong composition. */
export class DraftContentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DraftContentError";
    }
}

/** A draft whose originals are probed and captions converted, ready to be written in a transaction. */
export interface PreparedDraft {
    mediaId: string;
    draft: MediaDraft;
    originals: { draftFileId: string; probe: OriginalProbe }[];
    captions: { draftFileId: string; vtt: Uint8Array; declared: MediaDraft["captions"][number] }[];
}

/**
 * Checks and probes the drafts of one request, outside any transaction: each draft file must be an unused draft of
 * the library, originals are probed and must fit the composition rules, captions are converted to WebVTT.
 */
export async function prepareDrafts(libraryId: string, drafts: MediaDraft[]): Promise<PreparedDraft[]> {
    const ids = drafts.flatMap(draftFileIds);
    const rows =
        ids.length === 0
            ? []
            : await db
                  .select({ draft: DraftFile, file: DbFile })
                  .from(DraftFile)
                  .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
                  .where(and(inArray(DraftFile.id, ids), eq(DraftFile.library_id, libraryId), eq(DraftFile.status, DraftFileStatus.DRAFT)));
    const byId = new Map(rows.map((row) => [row.draft.id, row]));
    const missing = ids.find((id) => !byId.has(id));
    if (missing) throw new DraftContentError(`Draft file ${missing} is invalid or already consumed`);

    const structureError = validateDraftMediaGroups(drafts, (id) => byId.get(id)?.draft.original_name);
    if (structureError) throw new DraftContentError(structureError);

    const fileOf = (id: string) => {
        const { draft, file } = byId.get(id)!;
        return { name: draft.original_name, probed: file };
    };

    return Promise.all(
        drafts.map(async (draft) => {
            const name = draft.title.trim() || "Untitled media";
            try {
                const originals = await Promise.all(
                    draft.originals.map(async (draftFileId) => ({ draftFileId, probe: await probeOriginal(fileOf(draftFileId).probed) })),
                );
                const composition = compositionError(
                    draft.type,
                    originals.map(({ probe }) => kindOfProbe(probe)),
                );
                if (composition) throw new DraftContentError(composition);
                const captions = await Promise.all(
                    draft.captions.map(async (declared) => ({
                        draftFileId: declared.draft_file_id,
                        declared,
                        vtt: await convertToVtt(fileOf(declared.draft_file_id).probed),
                    })),
                );
                return { mediaId: uuidv7(), draft, originals, captions };
            } catch (error) {
                if (error instanceof DraftContentError || error instanceof ProbeRejectedError) {
                    throw new DraftContentError(`${name}: ${error.message}`);
                }
                throw error;
            }
        }),
    );
}

export type CreateMediaFromDraftOptions = {
    tx: Transaction;
    libraryId: string;
    prepared: PreparedDraft;
    sortOrder: number;
    now: Temporal.Instant;
    postId?: string;
};

/** Writes a prepared draft as a new, complete media: its originals, cover, captions and tags. */
export async function createMediaFromDraft({ tx, libraryId, prepared, sortOrder, now, postId }: CreateMediaFromDraftOptions) {
    const { mediaId, draft } = prepared;
    const media = { id: mediaId, type: draft.type, post_id: postId ?? null };

    await tx.insert(Media).values({
        id: mediaId,
        eid: mediaId,
        post_id: postId,
        sort_order: sortOrder,
        library_id: libraryId,
        source: PostSource.UNKNOWN,
        title: draft.title,
        description: draft.description,
        type: draft.type,
        sync_status: SyncStatus.COMPLETED,
        create_time: now,
        update_time: now,
    });

    for (const original of prepared.originals) {
        await insertUploadedOriginal(tx, media, await consumeDraftFile(tx, original.draftFileId, libraryId), original.probe);
    }
    if (draft.cover) await CoverService.setFile(tx, media, await consumeDraftFile(tx, draft.cover, libraryId));
    for (const caption of prepared.captions) {
        const sourceFileId = await consumeDraftFile(tx, caption.draftFileId, libraryId);
        const vttFileId = await storeVtt(tx, media, caption.draftFileId, caption.vtt);
        await insertUploadedCaption(tx, mediaId, { sourceFileId, vttFileId }, caption.declared);
    }

    if (draft.tag_ids.length > 0) await replaceMediaTagsTx(tx, mediaId, libraryId, draft.tag_ids);
    // A new media needs a search document.
    await markMediaMetaChanged(tx, [mediaId]);
    return mediaId;
}
