import { and, eq } from "drizzle-orm";
import { DraftFile, DraftFileStatus, File as DbFile, Media, Track, DeleteStatus } from "@/db/schema";
import { db } from "@/global/db";
import { DraftFileUnavailableError, consumeDraftFile } from "@/features/import/draft-file";
import { TrackService } from "./track";
import {
    assignTrackPriorities,
    validateDraftTrackFileTypes,
    validateMediaComposition,
    validateNoDuplicateDraftFileIds,
} from "@/lib/validation/media-composition";
import type { AddTracksFromDraftInput } from "./schema";
import { assertMediaReady } from "./composition";

export type AddTracksFromDraftErrorKind = "INVALID_PARAMETER" | "CONFLICT";

export class AddTracksFromDraftError extends Error {
    constructor(
        public readonly kind: AddTracksFromDraftErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "AddTracksFromDraftError";
    }
}

export async function addTracksFromDraft(media: typeof Media.$inferSelect, input: AddTracksFromDraftInput) {
    const tracks = input.tracks;
    const draftIdError = validateNoDuplicateDraftFileIds(tracks);
    if (draftIdError) {
        throw new AddTracksFromDraftError("INVALID_PARAMETER", draftIdError);
    }

    const incomingDefaultGroups = new Set(tracks.filter((track) => track.is_default).map((track) => `${track.type}:${track.purpose}`));
    const existingTracks = await db
        .select({
            type: Track.type,
            purpose: Track.purpose,
            is_default: Track.is_default,
            priority: Track.priority,
        })
        .from(Track)
        .where(and(eq(Track.media_id, media.id), eq(Track.delete_status, DeleteStatus.ACTIVE)));

    const prioritizedTracks = assignTrackPriorities(tracks, existingTracks);
    const effectiveTracks = [
        ...existingTracks.map((track) => ({
            ...track,
            is_default: incomingDefaultGroups.has(`${track.type}:${track.purpose}`) ? false : track.is_default,
        })),
        ...prioritizedTracks,
    ];
    const compositionError = validateMediaComposition(media.type, effectiveTracks);
    if (compositionError) {
        throw new AddTracksFromDraftError("INVALID_PARAMETER", compositionError);
    }

    const draftIds = tracks.map((track) => track.draft_file_id);
    const draftRows = await db
        .select({ draft: DraftFile, file: DbFile })
        .from(DraftFile)
        .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
        .where(and(eq(DraftFile.library_id, media.library_id), eq(DraftFile.status, DraftFileStatus.DRAFT)));

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
            throw new AddTracksFromDraftError("INVALID_PARAMETER", `Draft file ${draftId} is invalid or already consumed`);
        }
    }

    const fileTypeError = validateDraftTrackFileTypes([{ type: media.type, tracks }], activeDraftMap);
    if (fileTypeError) {
        throw new AddTracksFromDraftError("INVALID_PARAMETER", fileTypeError);
    }

    try {
        await db.transaction(async (tx) => {
            for (const track of prioritizedTracks) {
                const fileId = await consumeDraftFile(tx, track.draft_file_id, media.library_id);

                await TrackService.upsertTrack(
                    media.id,
                    {
                        type: track.type,
                        purpose: track.purpose,
                        quality: track.quality,
                        priority: track.priority,
                        is_default: track.is_default,
                        language: track.language || null,
                    },
                    fileId,
                    tx,
                    { deferCompositionCheck: true },
                );
            }

            await assertMediaReady(media.id, tx);
        });
    } catch (cause) {
        if (cause instanceof DraftFileUnavailableError) {
            throw new AddTracksFromDraftError("CONFLICT", cause.message);
        }
        throw cause;
    }

    return { success: true };
}
