import { and, count, eq, inArray } from "drizzle-orm";
import {
    Author,
    DeleteStatus,
    File,
    Library,
    LibraryGroupAccess,
    LibraryUserAccess,
    Media,
    MediaTag,
    Post,
    PostTag,
    Tag,
} from "@/db/schema";
import { db, type Transaction } from "@/global/db";
import { getErrorMessage } from "@/lib/utils/error";
import { LibraryDeleteError } from "./errors";

export type LibraryDeleteAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export async function hasLibraryContent(libraryId: string, tx?: Transaction) {
    const executor = tx ?? db;
    const [postRows, mediaRows] = await Promise.all([
        executor
            .select({ total: count() })
            .from(Post)
            .where(and(eq(Post.library_id, libraryId), eq(Post.delete_status, DeleteStatus.ACTIVE)))
            .limit(1),
        executor
            .select({ total: count() })
            .from(Media)
            .where(and(eq(Media.library_id, libraryId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
            .limit(1),
    ]);

    return (postRows[0]?.total ?? 0) > 0 || (mediaRows[0]?.total ?? 0) > 0;
}

export async function deleteLibrary(libraryId: string, auth: LibraryDeleteAuth) {
    try {
        return await db.transaction(async (tx) => {
            const [library] = await tx
                .select({ id: Library.id, owner_id: Library.owner_id, cover_file_id: Library.cover_file_id })
                .from(Library)
                .where(and(eq(Library.id, libraryId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);

            if (!library) {
                throw new LibraryDeleteError("NOT_FOUND", "Library not found");
            }
            if (library.owner_id !== auth.ownerId) {
                throw new LibraryDeleteError("FORBIDDEN", "You do not have access to this library");
            }
            if (auth.scopedLibraryId && auth.scopedLibraryId !== libraryId) {
                throw new LibraryDeleteError("FORBIDDEN", "API token scope restricted to another library");
            }

            if (await hasLibraryContent(libraryId, tx)) {
                throw new LibraryDeleteError("NOT_EMPTY", "Library is not empty");
            }

            const deleteTime = Temporal.Now.instant();
            await tx
                .update(Library)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(eq(Library.id, libraryId));

            if (library.cover_file_id) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(eq(File.id, library.cover_file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }

            const authors = await tx
                .select({
                    id: Author.id,
                    avatar_file_id: Author.avatar_file_id,
                    avatar_thumb_file_id: Author.avatar_thumb_file_id,
                })
                .from(Author)
                .where(and(eq(Author.library_id, libraryId), eq(Author.delete_status, DeleteStatus.ACTIVE)));

            if (authors.length > 0) {
                const authorIds = authors.map((author) => author.id);
                await tx
                    .update(Author)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Author.id, authorIds));

                const avatarFileIds = authors
                    .flatMap((author) => [author.avatar_file_id, author.avatar_thumb_file_id])
                    .filter((fileId): fileId is string => Boolean(fileId));

                if (avatarFileIds.length > 0) {
                    await tx
                        .update(File)
                        .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                        .where(and(inArray(File.id, avatarFileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
                }
            }

            const tags = await tx.select({ id: Tag.id }).from(Tag).where(eq(Tag.library_id, libraryId));
            if (tags.length > 0) {
                const tagIds = tags.map((tag) => tag.id);
                await tx.delete(PostTag).where(inArray(PostTag.tag_id, tagIds));
                await tx.delete(MediaTag).where(inArray(MediaTag.tag_id, tagIds));
                await tx.delete(Tag).where(inArray(Tag.id, tagIds));
            }

            await tx.delete(LibraryUserAccess).where(eq(LibraryUserAccess.library_id, libraryId));
            await tx.delete(LibraryGroupAccess).where(eq(LibraryGroupAccess.library_id, libraryId));

            return {
                libraryUpdated: 1,
                authorUpdated: authors.length,
                tagUpdated: tags.length,
            };
        });
    } catch (cause) {
        if (cause instanceof LibraryDeleteError) throw cause;
        throw new LibraryDeleteError("INTERNAL", getErrorMessage(cause));
    }
}
