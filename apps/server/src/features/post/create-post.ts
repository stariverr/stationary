import { and, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
    DeleteStatus,
    DraftFile,
    DraftFileStatus,
    File as DbFile,
    Library,
    Media,
    Post,
    PostSource,
    SyncStatus,
} from "@/db/schema";
import { db } from "@/global/db";
import { replacePostTagsTx } from "./post-service";
import { DraftFileUnavailableError } from "@/features/import/draft-file";
import { createMediaFromDraft } from "@/features/media/create-from-draft";
import {
    validateDraftMediaGroups,
    validateDraftTrackFileTypes,
} from "@/lib/validation/media-composition";
import type { CreatePostInput } from "./schema";

export type CreatePostErrorKind = "FORBIDDEN" | "INVALID_PARAMETER" | "CONFLICT";

export class CreatePostError extends Error {
    constructor(
        public readonly kind: CreatePostErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "CreatePostError";
    }
}

export async function createPost(input: CreatePostInput, ownerId: string): Promise<{ postId: string }> {
    const [library] = await db.select().from(Library).where(eq(Library.id, input.library_id)).limit(1);
    if (!library || library.owner_id !== ownerId) {
        throw new CreatePostError("FORBIDDEN", "You do not have access to this library");
    }

    const mediaIds = input.media_items?.filter((item) => item.kind === "existing").map((item) => item.media_id) ?? [];
    const mediaDrafts = input.media_items?.filter((item) => item.kind === "draft").map((item) => item.draft) ?? [];

    if (mediaDrafts.length > 0) {
        const compositionError = validateDraftMediaGroups(mediaDrafts);
        if (compositionError) {
            throw new CreatePostError("INVALID_PARAMETER", compositionError);
        }
    }

    if (mediaIds.length > 0) {
        const mediaList = await db
            .select()
            .from(Media)
            .where(and(inArray(Media.id, mediaIds), eq(Media.library_id, input.library_id)));
        if (mediaList.length !== mediaIds.length) {
            throw new CreatePostError("INVALID_PARAMETER", "Some media items are invalid or do not belong to this library");
        }
        for (const media of mediaList) {
            if (media.post_id !== null) {
                throw new CreatePostError("INVALID_PARAMETER", `Media ${media.title} is already linked to a post`);
            }
        }
    }

    const draftIds = mediaDrafts.flatMap((group) => group.tracks.map((track) => track.draft_file_id));
    if (draftIds.length > 0) {
        const draftRows = await db
            .select({ draft: DraftFile, file: DbFile })
            .from(DraftFile)
            .innerJoin(DbFile, eq(DraftFile.file_id, DbFile.id))
            .where(
                and(
                    eq(DraftFile.library_id, input.library_id),
                    eq(DraftFile.status, DraftFileStatus.DRAFT),
                    inArray(DraftFile.id, draftIds),
                ),
            );

        const activeDraftMap = new Map(
            draftRows.map(({ draft, file }) => [
                draft.id,
                {
                    name: draft.original_name,
                    mime_type: file.mime_type,
                },
            ]),
        );

        if (draftRows.length !== draftIds.length) {
            const missingId = draftIds.find((id) => !activeDraftMap.has(id));
            throw new CreatePostError("INVALID_PARAMETER", `Draft file ${missingId} is invalid or already consumed`);
        }

        const fileTypeError = validateDraftTrackFileTypes(mediaDrafts, activeDraftMap);
        if (fileTypeError) {
            throw new CreatePostError("INVALID_PARAMETER", fileTypeError);
        }
    }

    const postId = uuidv7();

    try {
        await db.transaction(async (tx) => {
            const now = Temporal.Now.instant();
            const totalMediaCount = input.media_items?.length ?? 0;

            await tx.insert(Post).values({
                id: postId,
                eid: postId,
                library_id: input.library_id,
                source: PostSource.UNKNOWN,
                title: input.title,
                description: input.description,
                media_count: totalMediaCount,
                sync_status: SyncStatus.PENDING,
                create_time: now,
                update_time: now,
                delete_status: DeleteStatus.ACTIVE,
            });

            if (input.tag_ids.length > 0) {
                await replacePostTagsTx(tx, postId, input.library_id, input.tag_ids);
            }

            let sortOrder = 0;

            for (const item of input.media_items ?? []) {
                if (item.kind === "existing") {
                    const updated = await tx
                        .update(Media)
                        .set({
                            post_id: postId,
                            sort_order: sortOrder++,
                            update_time: now,
                        })
                        .where(
                            and(
                                eq(Media.id, item.media_id),
                                eq(Media.library_id, input.library_id),
                                eq(Media.delete_status, DeleteStatus.ACTIVE),
                                isNull(Media.post_id),
                                isNull(Media.recycle_time),
                            ),
                        )
                        .returning({ id: Media.id });

                    if (updated.length === 0) {
                        throw new CreatePostError("INVALID_PARAMETER", `Media item ${item.media_id} is invalid or already bound to another post`);
                    }
                    continue;
                }

                await createMediaFromDraft({
                    tx,
                    libraryId: input.library_id,
                    draft: item.draft,
                    postId,
                    sortOrder: sortOrder++,
                    now,
                });
            }

            const activeMedias = await tx
                .select({ sync_status: Media.sync_status })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

            if (activeMedias.every((media) => media.sync_status === SyncStatus.COMPLETED)) {
                await tx
                    .update(Post)
                    .set({
                        sync_status: SyncStatus.COMPLETED,
                        update_time: now,
                    })
                    .where(eq(Post.id, postId));
            }
        });
    } catch (error) {
        if (error instanceof DraftFileUnavailableError) {
            throw new CreatePostError("CONFLICT", error.message);
        }
        throw error;
    }

    return { postId };
}
