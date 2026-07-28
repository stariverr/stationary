import { and, count, eq, inArray, or } from "drizzle-orm";
import { db, Transaction } from "@/global/db";
import { Post, Media, Track, File, Library, Author, DeleteStatus, PostTag, MediaTag } from "@/db/schema";

import { RecycleService } from "./recycle";
import { Temporal } from "@js-temporal/polyfill";

export const DeleteService = {
    /** Delete Post and its media and files */
    async deletePost(postId: string) {
        const deleteTime = Temporal.Now.instant();
        return db.transaction(async (tx) => {
            // 1. Get post
            const posts = await tx
                .select({ id: Post.id })
                .from(Post)
                .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            if (posts.length === 0) return { postUpdated: 0 };

            // 2. Get media list
            const medias = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));
            const mediaIds = medias.map((m) => m.id);

            let fileIds: string[] = [];
            if (mediaIds.length > 0) {
                const tracks = await tx
                    .select({ file_id: Track.file_id })
                    .from(Track)
                    .where(and(inArray(Track.media_id, mediaIds), eq(Track.delete_status, DeleteStatus.ACTIVE)));
                fileIds = tracks.map((mf) => mf.file_id).filter((fid): fid is string => !!fid);
            }

            // 3. Perform synchronous updates
            await tx.delete(PostTag).where(eq(PostTag.post_id, postId));
            await tx.update(Post).set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime }).where(eq(Post.id, postId));
            if (mediaIds.length > 0) {
                await tx
                    .update(Media)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(inArray(Media.id, mediaIds));
                await tx
                    .update(Track)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(inArray(Track.media_id, mediaIds));
            }
            // 4. Soft-delete associated files
            // NOTE: Currently assumes 1:1 mapping between Media/Track and File.
            // If deduplication or shared file references are introduced in the future,
            // verify references with canPurgeFile() or dynamic file_usage mappings before marking File as DELETED.
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(inArray(File.id, fileIds));
            }

            return { postUpdated: 1, mediaUpdated: mediaIds.length, fileUpdated: fileIds.length };
        });
    },

    /** Delete Media and its affiliated contents */
    async deleteMedia(mediaId: string) {
        const deleteTime = Temporal.Now.instant();
        return db.transaction(async (tx) => {
            const medias = await tx
                .select({ id: Media.id })
                .from(Media)
                .where(and(eq(Media.id, mediaId), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            if (medias.length === 0) return { mediaUpdated: 0 };

            const tracks = await tx
                .select({ file_id: Track.file_id })
                .from(Track)
                .where(and(eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));
            const fileIds = tracks.map((mf) => mf.file_id).filter((fid): fid is string => !!fid);

            await tx.delete(MediaTag).where(eq(MediaTag.media_id, mediaId));
            await tx.update(Media).set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime }).where(eq(Media.id, mediaId));
            await tx.update(Track).set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime }).where(eq(Track.media_id, mediaId));
            // NOTE: Assumes 1:1 mapping between Media/Track and File.
            // Check canPurgeFile() if physical file sharing is supported later.
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(inArray(File.id, fileIds));
            }

            return { mediaUpdated: 1, fileUpdated: fileIds.length };
        });
    },

    /** Delete Library
     *
     * Delete is allowed only when the library is empty
     */
    async deleteLibrary(libraryId: string) {
        const deleteTime = Temporal.Now.instant();

        // 1. Fast-fail check outside transaction
        const hasContent = await RecycleService.libraryHasContent(libraryId);
        if (hasContent) {
            throw new Error("Library is not empty");
        }

        // 2. Perform soft-delete in lightweight transaction
        return db.transaction(async (tx) => {
            const libs = await tx
                .select({ id: Library.id, cover_file_id: Library.cover_file_id })
                .from(Library)
                .where(and(eq(Library.id, libraryId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            const library = libs[0];
            if (!library) return { libraryUpdated: 0 };

            await tx.update(Library).set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime }).where(eq(Library.id, libraryId));
            if (library.cover_file_id) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(eq(File.id, library.cover_file_id));
            }

            return { libraryUpdated: 1 };
        });
    },

    async deleteAuthor(authorId: string) {
        const deleteTime = Temporal.Now.instant();
        return db.transaction(async (tx) => {
            const authors = await tx
                .select({
                    id: Author.id,
                    avatar_file_id: Author.avatar_file_id,
                    avatar_thumb_file_id: Author.avatar_thumb_file_id,
                })
                .from(Author)
                .where(and(eq(Author.id, authorId), eq(Author.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            const author = authors[0];
            if (!author) return { authorUpdated: 0 };

            // Soft Delete Author
            await tx.update(Author).set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime }).where(eq(Author.id, authorId));

            const fileIds = [author.avatar_file_id, author.avatar_thumb_file_id].filter((fid): fid is string => !!fid);
            // Soft Delete Author Avatar File
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(inArray(File.id, fileIds));
            }

            // Empty author_id of posts
            // This update also includes soft deleted posts
            await tx.update(Post).set({ author_id: null }).where(eq(Post.author_id, authorId));

            return { authorUpdated: 1 };
        });
    },

    /** Check if File can be purged (it is not referenced by any active entity) */
    async canPurgeFile(fileId: string, tx?: Transaction): Promise<boolean> {
        const executor = tx || db;
        const [authorCount, libraryCount, mediaFileCount] = await Promise.all([
            executor
                .select({ count: count() })
                .from(Author)
                .where(
                    and(
                        or(eq(Author.avatar_file_id, fileId), eq(Author.avatar_thumb_file_id, fileId)),
                        eq(Author.delete_status, DeleteStatus.ACTIVE),
                    ),
                ),
            executor
                .select({ count: count() })
                .from(Library)
                .where(and(eq(Library.cover_file_id, fileId), eq(Library.delete_status, DeleteStatus.ACTIVE))),
            executor
                .select({ count: count() })
                .from(Track)
                .where(and(eq(Track.file_id, fileId), eq(Track.delete_status, DeleteStatus.ACTIVE))),
        ]);

        const authors = authorCount[0]?.count ?? 0;
        const libraries = libraryCount[0]?.count ?? 0;
        const tracks = mediaFileCount[0]?.count ?? 0;

        return authors + libraries + tracks === 0;
    },
};
