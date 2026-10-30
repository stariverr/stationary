import { and, eq, inArray } from "drizzle-orm";
import { DeleteStatus, Library, Media, Post } from "@/db/schema";
import { db } from "@/global/db";

export type LibraryAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

/** Keeps the libraries the caller owns and its API token may reach, so a foreign library reads exactly like a missing one. */
export function reachableLibraryFilter(auth: LibraryAuth) {
    return and(
        eq(Library.owner_id, auth.ownerId),
        eq(Library.delete_status, DeleteStatus.ACTIVE),
        auth.scopedLibraryId ? eq(Library.id, auth.scopedLibraryId) : undefined,
    );
}

export async function findOwnedLibrary(libraryId: string, auth: LibraryAuth) {
    const [library] = await db
        .select()
        .from(Library)
        .where(and(eq(Library.id, libraryId), reachableLibraryFilter(auth)))
        .limit(1);
    return library ?? null;
}

/** Whether every id names a post or media item in a library the caller can reach. */
export async function canReachItems(postIds: string[], mediaIds: string[], auth: LibraryAuth) {
    const uniquePostIds = Array.from(new Set(postIds));
    const uniqueMediaIds = Array.from(new Set(mediaIds));

    const [posts, media] = await Promise.all([
        uniquePostIds.length > 0
            ? db
                  .select({ id: Post.id })
                  .from(Post)
                  .innerJoin(Library, eq(Library.id, Post.library_id))
                  .where(and(inArray(Post.id, uniquePostIds), reachableLibraryFilter(auth)))
            : [],
        uniqueMediaIds.length > 0
            ? db
                  .select({ id: Media.id })
                  .from(Media)
                  .innerJoin(Library, eq(Library.id, Media.library_id))
                  .where(and(inArray(Media.id, uniqueMediaIds), reachableLibraryFilter(auth)))
            : [],
    ]);

    return posts.length === uniquePostIds.length && media.length === uniqueMediaIds.length;
}
