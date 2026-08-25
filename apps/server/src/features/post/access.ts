import { eq } from "drizzle-orm";
import { Library, Post, DeleteStatus } from "@/db/schema";
import { db } from "@/global/db";

export type PostAccessAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export type PostAccessErrorKind = "NOT_FOUND" | "FORBIDDEN";

export class PostAccessError extends Error {
    constructor(
        public readonly kind: PostAccessErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "PostAccessError";
    }
}

export async function assertPostAccess(postId: string, auth: PostAccessAuth) {
    const [post] = await db.select().from(Post).where(eq(Post.id, postId)).limit(1);

    if (!post || post.delete_status !== DeleteStatus.ACTIVE || post.recycle_time !== null) {
        throw new PostAccessError("NOT_FOUND", "Post not found or is in recycle bin");
    }

    const [library] = await db.select().from(Library).where(eq(Library.id, post.library_id)).limit(1);
    if (!library || library.owner_id !== auth.ownerId) {
        throw new PostAccessError("FORBIDDEN", "You do not have access to this library");
    }

    if (auth.scopedLibraryId && auth.scopedLibraryId !== post.library_id) {
        throw new PostAccessError("FORBIDDEN", "API token scope restricted to another library");
    }

    return post;
}
