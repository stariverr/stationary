import { and, eq } from "drizzle-orm";
import { Library, Post, DeleteStatus } from "@/db/schema";
import { reachableLibraryFilter, type LibraryAuth } from "@/features/library/access";
import { db } from "@/global/db";

export class PostAccessError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PostAccessError";
    }
}

export async function assertPostAccess(postId: string, auth: LibraryAuth, options: { allowRecycled?: boolean } = {}) {
    const [row] = await db
        .select({ post: Post })
        .from(Post)
        .innerJoin(Library, eq(Library.id, Post.library_id))
        .where(and(eq(Post.id, postId), reachableLibraryFilter(auth)))
        .limit(1);

    if (!row || row.post.delete_status !== DeleteStatus.ACTIVE || (!options.allowRecycled && row.post.recycle_time !== null)) {
        throw new PostAccessError("Post not found or is in recycle bin");
    }

    return row.post;
}
