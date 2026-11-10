import { and, eq, inArray, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import {
    DeleteStatus,
    DraftFile,
    DraftFileStatus,
    File as DbFile,
    Media,
    Post,
    PostSource,
    SyncStatus,
} from "@/db/schema";
import { findOwnedLibrary, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";
import { replacePostTagsTx } from "./post-service";
import { DraftFileUnavailableError } from "@/features/import/draft-file";
import { createMediaFromDraft, DraftContentError, prepareDrafts, type PreparedDraft } from "@/features/media/create-from-draft";
import type { CreatePostInput } from "./schema";

export type CreatePostErrorKind = "NOT_FOUND" | "INVALID_PARAMETER" | "CONFLICT";

export class CreatePostError extends Error {
    constructor(
        public readonly kind: CreatePostErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "CreatePostError";
    }
}

export async function createPost(input: CreatePostInput, auth: LibraryAuth): Promise<{ postId: string }> {
    const library = await findOwnedLibrary(input.library_id, auth);
    if (!library) {
        throw new CreatePostError("NOT_FOUND", "Library not found");
    }

    const mediaIds = input.media_items?.filter((item) => item.kind === "existing").map((item) => item.media_id) ?? [];
    const mediaDrafts = input.media_items?.filter((item) => item.kind === "draft").map((item) => item.draft) ?? [];

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

    // Drafts are probed before the transaction; each one is matched back to its item by position.
    let prepared: PreparedDraft[] = [];
    try {
        prepared = await prepareDrafts(input.library_id, mediaDrafts);
    } catch (error) {
        if (error instanceof DraftContentError) throw new CreatePostError("INVALID_PARAMETER", error.message);
        throw error;
    }
    const preparedQueue = [...prepared];

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
                    prepared: preparedQueue.shift()!,
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
