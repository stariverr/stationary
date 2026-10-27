import { and, asc, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { Author, DeleteStatus, File } from "@/db/schema";
import { db } from "@/global/db";
import { env } from "@/global/env";
import { s3 } from "@/global/s3";
import type { PipelineHandler } from "@/infra/queue/types";
import { downloadStream, getBodyLength, getExtensionFromContentType, uploadToS3 } from "@/lib/utils/media";

type AvatarSource = Pick<typeof Author.$inferSelect, "avatar_source_url" | "avatar_source_file_id">;

/** Identifies the wanted avatar source, so a stored avatar or failure can be compared with it. */
export function avatarOrigin(author: AvatarSource): string | null {
    if (author.avatar_source_file_id) return `file:${author.avatar_source_file_id}`;
    if (author.avatar_source_url) return `url:${author.avatar_source_url}`;
    return null;
}

/** avatarOrigin() in SQL. */
const wantedOrigin = sql<string | null>`CASE
    WHEN ${Author.avatar_source_file_id} IS NOT NULL THEN 'file:' || ${Author.avatar_source_file_id}
    WHEN NULLIF(${Author.avatar_source_url}, '') IS NOT NULL THEN 'url:' || ${Author.avatar_source_url}
END`;

const failedAuthors = (libraryIds: readonly string[]) =>
    and(
        inArray(Author.library_id, [...libraryIds]),
        eq(Author.delete_status, DeleteStatus.ACTIVE),
        isNotNull(Author.avatar_error),
        sql`${Author.avatar_error_origin} = ${wantedOrigin}`,
    );

const activeAuthor = (authorId: string) => and(eq(Author.id, authorId), eq(Author.delete_status, DeleteStatus.ACTIVE));

const avatarPath = (authorId: string, ext: string) => `v2/a/${authorId.slice(-2)}/${authorId}/original.${ext}`;

interface StoredAvatar {
    path: string;
    bucket: string;
    mimeType: string;
    extension: string;
    size: number | null;
}

/**
 * `avatar`: makes an author's avatar file come from its wanted source. Ingest sets a remote URL, which is downloaded;
 * moving a post to another library sets the source author's file, which is copied so each author owns its file.
 */
export const avatarPipeline: PipelineHandler = {
    async reconcile(ctx) {
        const [author] = await db.select().from(Author).where(activeAuthor(ctx.subjectId)).limit(1);
        if (!author) return { kind: "done" };
        const origin = avatarOrigin(author);
        if (!origin || (author.avatar_file_id && author.avatar_origin === origin)) return { kind: "done" };

        let stored: StoredAvatar;
        if (author.avatar_source_file_id) {
            const [source] = await db
                .select()
                .from(File)
                .where(and(eq(File.id, author.avatar_source_file_id), eq(File.delete_status, DeleteStatus.ACTIVE)))
                .limit(1);
            if (!source) return { kind: "failed", error: "The avatar file to copy no longer exists" };
            const extension = source.extension || "bin";
            const path = avatarPath(author.id, extension);
            await s3.copy(source.path, path, { bucket: source.bucket, signal: ctx.signal });
            stored = {
                path,
                bucket: source.bucket,
                mimeType: source.mime_type || "application/octet-stream",
                extension,
                size: source.size,
            };
        } else {
            const url = author.avatar_source_url!;
            const response = await downloadStream(url, { signal: ctx.signal });
            if (!response?.body) throw new Error(`Download of ${url} returned no body`);
            const mimeType = response.headers.get("Content-Type") || "application/octet-stream";
            const size = getBodyLength(response) ?? null;
            const extension = getExtensionFromContentType(mimeType, url);
            const path = avatarPath(author.id, extension);
            await uploadToS3(path, response.body, mimeType, env.S3_BUCKET, size ?? undefined, ctx.signal);
            stored = { path, bucket: env.S3_BUCKET, mimeType, extension, size };
        }
        ctx.signal.throwIfAborted();

        await db.transaction(async (tx) => {
            await ctx.fence(tx);
            const [file] = await tx
                .insert(File)
                .values({
                    path: stored.path,
                    mime_type: stored.mimeType,
                    extension: stored.extension,
                    bucket: stored.bucket,
                    size: stored.size,
                })
                .onConflictDoUpdate({
                    target: File.path,
                    set: {
                        mime_type: stored.mimeType,
                        extension: stored.extension,
                        size: stored.size,
                        delete_status: DeleteStatus.ACTIVE,
                        delete_time: null,
                    },
                })
                .returning({ id: File.id });
            await tx
                .update(Author)
                .set({
                    avatar_file_id: file!.id,
                    avatar_origin: origin,
                    avatar_error: null,
                    avatar_error_origin: null,
                    update_time: Temporal.Now.instant(),
                })
                .where(activeAuthor(author.id));
            if (author.avatar_file_id && author.avatar_file_id !== file!.id) {
                await tx
                    .update(File)
                    .set({ delete_status: DeleteStatus.DELETED, delete_time: Temporal.Now.instant() })
                    .where(and(eq(File.id, author.avatar_file_id), eq(File.delete_status, DeleteStatus.ACTIVE)));
            }
        });
        return { kind: "done" };
    },

    async recordFailure(tx, authorId, error) {
        const [author] = await tx
            .select({ avatar_source_url: Author.avatar_source_url, avatar_source_file_id: Author.avatar_source_file_id })
            .from(Author)
            .where(activeAuthor(authorId))
            .limit(1);
        if (!author) return;
        await tx
            .update(Author)
            .set({ avatar_error: error, avatar_error_origin: avatarOrigin(author), update_time: Temporal.Now.instant() })
            .where(activeAuthor(authorId));
    },

    async scanPage(libraryId, cursor, limit) {
        const conditions = [eq(Author.library_id, libraryId), eq(Author.delete_status, DeleteStatus.ACTIVE)];
        if (cursor) conditions.push(gt(Author.id, cursor));
        const page = await db
            .select({
                id: Author.id,
                avatar_file_id: Author.avatar_file_id,
                avatar_source_url: Author.avatar_source_url,
                avatar_source_file_id: Author.avatar_source_file_id,
                avatar_origin: Author.avatar_origin,
                avatar_error_origin: Author.avatar_error_origin,
            })
            .from(Author)
            .where(and(...conditions))
            .orderBy(asc(Author.id))
            .limit(limit);

        const subjectIds = page
            .filter((author) => {
                const origin = avatarOrigin(author);
                if (!origin || author.avatar_error_origin === origin) return false;
                return !(author.avatar_file_id && author.avatar_origin === origin);
            })
            .map((author) => author.id);
        return { subjectIds, nextCursor: page.length === limit ? page[page.length - 1]!.id : null };
    },

    async countFailures(libraryIds) {
        if (libraryIds.length === 0) return new Map();
        const rows = await db
            .select({ libraryId: Author.library_id, count: sql<number>`count(*)::int` })
            .from(Author)
            .where(failedAuthors(libraryIds))
            .groupBy(Author.library_id);
        return new Map(rows.map((row) => [row.libraryId, row.count]));
    },

    async listFailures(libraryId, limit) {
        const query = db
            .select({ subjectId: Author.id, label: Author.nickname, error: Author.avatar_error, time: Author.update_time })
            .from(Author)
            .where(failedAuthors([libraryId]))
            .orderBy(desc(Author.update_time))
            .$dynamic();
        const rows = limit === undefined ? await query : await query.limit(limit);
        return rows.map((row) => ({ ...row, error: row.error ?? "" }));
    },
};
