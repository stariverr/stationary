import * as v from "valibot";
import { v7 as uuidv7 } from "uuid";
import { Media, PostSource, SyncStatus } from "@/db/schema";
import type { Transaction } from "@/global/db";
import { consumeDraftFile } from "@/features/import/draft-file";
import { TrackService } from "./track";
import { assignTrackPriorities, MediaDraftSchema } from "@/lib/validation/media-composition";
import { replaceMediaTagsTx } from "./tags";
import { assertMediaReady } from "./composition";

export type DraftMediaInput = v.InferOutput<typeof MediaDraftSchema>;

export type CreateMediaFromDraftOptions = {
    tx: Transaction;
    libraryId: string;
    draft: DraftMediaInput;
    sortOrder: number;
    now: Temporal.Instant;
    postId?: string;
};

export async function createMediaFromDraft({ tx, libraryId, draft, sortOrder, now, postId }: CreateMediaFromDraftOptions) {
    const mediaId = uuidv7();

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
        sync_status: SyncStatus.PENDING,
        create_time: now,
        update_time: now,
    });

    for (const track of assignTrackPriorities(draft.tracks)) {
        const fileId = await consumeDraftFile(tx, track.draft_file_id, libraryId);

        await TrackService.upsertTrack(
            mediaId,
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

    await assertMediaReady(mediaId, tx);

    if (draft.tag_ids.length > 0) {
        await replaceMediaTagsTx(tx, mediaId, libraryId, draft.tag_ids);
    }

    return mediaId;
}
