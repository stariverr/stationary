import { and, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/global/db";
import {
    Post,
    Media,
    Track,
    File,
    Library,
    Author,
    DeleteStatus,
    PostTag,
    MediaTag,
    Tag,
    LibraryUserAccess,
    LibraryGroupAccess,
} from "@/db/schema";

import { RecycleService } from "./recycle";
import { MediaService } from "./media";
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
            await tx
                .update(Post)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(eq(Post.id, postId));
            if (mediaIds.length > 0) {
                await tx
                    .update(Media)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Media.id, mediaIds));
                await tx
                    .update(Track)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Track.media_id, mediaIds));
            }
            // 4. Each Track owns its File in the current model.
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }

            return { postUpdated: 1, mediaUpdated: mediaIds.length, fileUpdated: fileIds.length };
        });
    },

    /** Delete Media and its affiliated contents */
    async deleteMedia(mediaId: string) {
        const deleteTime = Temporal.Now.instant();
        return db.transaction(async (tx) => {
            const medias = await tx
                .select({ id: Media.id, post_id: Media.post_id })
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
            await tx
                .update(Media)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(eq(Media.id, mediaId));
            await tx
                .update(Track)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(eq(Track.media_id, mediaId));
            // Each Track owns its File in the current model.
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }

            if (medias[0]?.post_id) {
                const [activeCount] = await tx
                    .select({ count: count() })
                    .from(Media)
                    .where(and(eq(Media.post_id, medias[0].post_id), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
                await tx
                    .update(Post)
                    .set({ media_count: activeCount?.count ?? 0, update_time: deleteTime })
                    .where(eq(Post.id, medias[0].post_id));
            }

            return { mediaUpdated: 1, fileUpdated: fileIds.length };
        });
    },

    /** Delete Track and its file */
    async deleteTrack(mediaId: string, trackId: string) {
        return db.transaction(async (tx) => {
            const now = Temporal.Now.instant();

            const [trackRecord] = await tx
                .select()
                .from(Track)
                .where(and(eq(Track.id, trackId), eq(Track.media_id, mediaId), eq(Track.delete_status, DeleteStatus.ACTIVE)));

            if (!trackRecord) {
                throw new Error("Track not found");
            }

            await tx
                .update(Track)
                .set({
                    delete_status: DeleteStatus.DELETED,
                    delete_time: now,
                    update_time: now,
                })
                .where(eq(Track.id, trackId));

            await MediaService.assertMediaComposition(mediaId, tx);
            if (trackRecord.file_id) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: now })
                    .where(and(eq(File.id, trackRecord.file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }

            return { success: true };
        });
    },

    /** Delete Library
     *
     * Delete is allowed only when the library is empty (no active Posts or Media).
     * Cascades soft-delete to associated Authors and hard-delete to Tags and Access records.
     */
    async deleteLibrary(libraryId: string) {
        const deleteTime = Temporal.Now.instant();

        // 1. Fast-fail check outside transaction
        const hasContent = await RecycleService.libraryHasContent(libraryId);
        if (hasContent) {
            throw new Error("Library is not empty");
        }

        // 2. Perform soft-delete and cascade cleanups in transaction
        return db.transaction(async (tx) => {
            const libs = await tx
                .select({ id: Library.id, cover_file_id: Library.cover_file_id })
                .from(Library)
                .where(and(eq(Library.id, libraryId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            const library = libs[0];
            if (!library) return { libraryUpdated: 0 };

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

            // Cascade soft-delete Authors of this library
            const authors = await tx
                .select({
                    id: Author.id,
                    avatar_file_id: Author.avatar_file_id,
                    avatar_thumb_file_id: Author.avatar_thumb_file_id,
                })
                .from(Author)
                .where(and(eq(Author.library_id, libraryId), eq(Author.delete_status, DeleteStatus.ACTIVE)));

            if (authors.length > 0) {
                const authorIds = authors.map((a) => a.id);
                await tx
                    .update(Author)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                    .where(inArray(Author.id, authorIds));

                const avatarFileIds = authors
                    .flatMap((a) => [a.avatar_file_id, a.avatar_thumb_file_id])
                    .filter((fid): fid is string => !!fid);

                if (avatarFileIds.length > 0) {
                    await tx
                        .update(File)
                        .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                        .where(and(inArray(File.id, avatarFileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
                }
            }

            // Cascade hard-delete Tags belonging to this library
            const tags = await tx
                .select({ id: Tag.id })
                .from(Tag)
                .where(eq(Tag.library_id, libraryId));

            if (tags.length > 0) {
                const tagIds = tags.map((t) => t.id);
                await tx.delete(PostTag).where(inArray(PostTag.tag_id, tagIds));
                await tx.delete(MediaTag).where(inArray(MediaTag.tag_id, tagIds));
                await tx.delete(Tag).where(inArray(Tag.id, tagIds));
            }

            // Clean up library access rules
            await tx.delete(LibraryUserAccess).where(eq(LibraryUserAccess.library_id, libraryId));
            await tx.delete(LibraryGroupAccess).where(eq(LibraryGroupAccess.library_id, libraryId));

            return {
                libraryUpdated: 1,
                authorUpdated: authors.length,
                tagUpdated: tags.length,
            };
        });
    },

    /** Delete Author and soft-delete avatar files */
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
            await tx
                .update(Author)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
                .where(eq(Author.id, authorId));

            const fileIds = [author.avatar_file_id, author.avatar_thumb_file_id].filter((fid): fid is string => !!fid);
            if (fileIds.length > 0) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                    .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }

            // Empty author_id of posts
            // This update also includes soft deleted posts
            await tx.update(Post).set({ author_id: null }).where(eq(Post.author_id, authorId));

            return { authorUpdated: 1 };
        });
    },

    /** Delete Tag and remove its post/media tag relations & dissociate canonical tag references */
    async deleteTag(tagId: string) {
        return db.transaction(async (tx) => {
            const tagDeleted = await tx.delete(Tag).where(eq(Tag.id, tagId)).returning({ id: Tag.id });
            if (tagDeleted.length === 0) return { tagDeleted: 0 };

            await tx.delete(PostTag).where(eq(PostTag.tag_id, tagId));
            await tx.delete(MediaTag).where(eq(MediaTag.tag_id, tagId));

            // Dissociate aliases
            await tx
                .update(Tag)
                .set({ canonical_tag_id: null, update_time: sql`now()` })
                .where(eq(Tag.canonical_tag_id, tagId));

            return { tagDeleted: 1 };
        });
    },
};
