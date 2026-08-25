import { and, eq, inArray } from "drizzle-orm";
import { DeleteStatus, Library, Media, Post, SyncStatus } from "@/db/schema";
import { db } from "@/global/db";
import { RetrySyncError } from "./errors";
import type { RetrySyncInput } from "./schema";

export type RetrySyncAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export async function retrySync(input: RetrySyncInput, auth: RetrySyncAuth) {
    const resolvedPostIds = new Set(input.post_ids ?? []);
    const requestedLibraryIds = new Set<string>();

    if (input.media_ids?.length) {
        const mediaList = await db
            .select({ id: Media.id, post_id: Media.post_id, library_id: Media.library_id })
            .from(Media)
            .where(inArray(Media.id, input.media_ids));

        if (mediaList.length !== input.media_ids.length) {
            throw new RetrySyncError("INVALID_PARAMETER", "One or more media items were not found");
        }

        for (const media of mediaList) {
            requestedLibraryIds.add(media.library_id);
            if (media.post_id) {
                resolvedPostIds.add(media.post_id);
            }
        }
    }

    const postIds = Array.from(resolvedPostIds);
    if (postIds.length > 0) {
        const posts = await db
            .select({ id: Post.id, library_id: Post.library_id })
            .from(Post)
            .where(inArray(Post.id, postIds));

        if (posts.length !== postIds.length) {
            throw new RetrySyncError("INVALID_PARAMETER", "One or more posts were not found");
        }

        for (const post of posts) {
            requestedLibraryIds.add(post.library_id);
        }
    }

    const libraryIds = Array.from(requestedLibraryIds);
    const libraries = await db
        .select({ id: Library.id, owner_id: Library.owner_id })
        .from(Library)
        .where(and(inArray(Library.id, libraryIds), eq(Library.delete_status, DeleteStatus.ACTIVE)));

    if (
        libraries.length !== libraryIds.length ||
        libraries.some((library) => library.owner_id !== auth.ownerId) ||
        (auth.scopedLibraryId !== undefined && libraryIds.some((libraryId) => libraryId !== auth.scopedLibraryId))
    ) {
        throw new RetrySyncError("FORBIDDEN", "You do not have access to some of the libraries");
    }

    let retriedCount = 0;
    if (input.post_ids?.length) {
        const posts = await db
            .update(Post)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(inArray(Post.id, input.post_ids))
            .returning({ id: Post.id });
        retriedCount += posts.length;
    }
    if (input.media_ids?.length) {
        const media = await db
            .update(Media)
            .set({ sync_status: SyncStatus.PENDING, last_error: null })
            .where(inArray(Media.id, input.media_ids))
            .returning({ id: Media.id });
        retriedCount += media.length;
    }

    return { retriedCount };
}
