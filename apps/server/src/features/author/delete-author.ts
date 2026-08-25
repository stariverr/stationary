import { and, eq, inArray } from "drizzle-orm";
import { Author, DeleteStatus, File, Post } from "@/db/schema";
import { db } from "@/global/db";

export async function deleteAuthor(authorId: string) {
    const deleteTime = Temporal.Now.instant();

    return db.transaction(async (tx) => {
        const [author] = await tx
            .select({
                id: Author.id,
                avatar_file_id: Author.avatar_file_id,
                avatar_thumb_file_id: Author.avatar_thumb_file_id,
            })
            .from(Author)
            .where(and(eq(Author.id, authorId), eq(Author.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);

        if (!author) return { authorUpdated: 0 };

        await tx
            .update(Author)
            .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime, update_time: deleteTime })
            .where(eq(Author.id, authorId));

        const fileIds = [author.avatar_file_id, author.avatar_thumb_file_id].filter((fileId): fileId is string => Boolean(fileId));
        if (fileIds.length > 0) {
            await tx
                .update(File)
                .set({ delete_status: DeleteStatus.DELETED, delete_time: deleteTime })
                .where(and(inArray(File.id, fileIds), eq(File.delete_status, DeleteStatus.ACTIVE)));
        }

        await tx.update(Post).set({ author_id: null }).where(eq(Post.author_id, authorId));

        return { authorUpdated: 1 };
    });
}
