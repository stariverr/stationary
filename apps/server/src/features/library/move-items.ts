import { and, eq, inArray, isNull } from "drizzle-orm";
import {
    AsyncSubjectType,
    AsyncTaskType,
    AsyncTaskUnitKind,
    Author,
    DeleteStatus,
    Library,
    Media,
    MediaTag,
    Post,
    PostTag,
    Tag,
} from "@/db/schema";
import { db } from "@/global/db";
import { JobManager } from "@/infra/jobs/manager";
import { LibraryMoveError } from "./errors";
import type { LibraryMoveItemsInput } from "./schema";

export type LibraryMoveAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export const uniqueIds = (ids: string[]) => Array.from(new Set(ids));

export const getAttachedMediaIds = (media: Pick<typeof Media.$inferSelect, "id" | "post_id">[]) =>
    media.filter((item) => item.post_id !== null).map((item) => item.id);

export async function moveLibraryItems(input: LibraryMoveItemsInput, auth: LibraryMoveAuth) {
    const [targetLibrary] = await db
        .select({ id: Library.id, owner_id: Library.owner_id })
        .from(Library)
        .where(and(eq(Library.id, input.target_library_id), eq(Library.delete_status, DeleteStatus.ACTIVE)))
        .limit(1);

    if (!targetLibrary) {
        throw new LibraryMoveError("NOT_FOUND", "Target library not found");
    }
    if (targetLibrary.owner_id !== auth.ownerId) {
        throw new LibraryMoveError("FORBIDDEN", "You do not have access to the target library");
    }
    if (auth.scopedLibraryId && auth.scopedLibraryId !== input.target_library_id) {
        throw new LibraryMoveError("FORBIDDEN", "API token scope restricted to another library");
    }

    const moved = await db.transaction(async (tx) => {
        const selectedPosts =
            input.post_ids.length > 0
                ? await tx
                      .select({ id: Post.id, author_id: Post.author_id, library_id: Post.library_id })
                      .from(Post)
                      .where(and(inArray(Post.id, input.post_ids), eq(Post.delete_status, DeleteStatus.ACTIVE)))
                : [];

        if (selectedPosts.length !== input.post_ids.length) {
            throw new LibraryMoveError("INVALID_PARAMETER", "One or more posts were not found or not active");
        }

        const selectedMedia =
            input.media_ids.length > 0
                ? await tx
                      .select({ id: Media.id, post_id: Media.post_id, library_id: Media.library_id })
                      .from(Media)
                      .where(and(inArray(Media.id, input.media_ids), eq(Media.delete_status, DeleteStatus.ACTIVE)))
                : [];

        if (selectedMedia.length !== input.media_ids.length) {
            throw new LibraryMoveError("INVALID_PARAMETER", "One or more media items were not found or not active");
        }

        const sourceLibraryIds = uniqueIds([
            ...selectedPosts.map((post) => post.library_id),
            ...selectedMedia.map((media) => media.library_id),
        ]);
        if (sourceLibraryIds.length > 0) {
            const sourceLibraries = await tx
                .select({ owner_id: Library.owner_id })
                .from(Library)
                .where(and(inArray(Library.id, sourceLibraryIds), eq(Library.delete_status, DeleteStatus.ACTIVE)));
            if (sourceLibraries.length !== sourceLibraryIds.length || sourceLibraries.some((library) => library.owner_id !== auth.ownerId)) {
                throw new LibraryMoveError("FORBIDDEN", "You do not have access to all source libraries");
            }
        }

        if (getAttachedMediaIds(selectedMedia).length > 0) {
            throw new LibraryMoveError("INVALID_PARAMETER", "Only independent media can be moved directly");
        }

        const sourceAuthorIds = uniqueIds(selectedPosts.map((post) => post.author_id).filter((id): id is string => !!id));
        const sourceAuthors =
            sourceAuthorIds.length > 0
                ? await tx
                      .select()
                      .from(Author)
                      .where(and(inArray(Author.id, sourceAuthorIds), eq(Author.delete_status, DeleteStatus.ACTIVE)))
                : [];

        const authorMap = new Map<string, string>();
        const avatarCopyJobs: Array<{ sourceAuthorId: string; targetAuthorId: string }> = [];

        if (sourceAuthors.length > 0) {
            const targetAuthors = await tx
                .select()
                .from(Author)
                .where(and(eq(Author.library_id, input.target_library_id), eq(Author.delete_status, DeleteStatus.ACTIVE)));

            for (const sourceAuthor of sourceAuthors) {
                const matched = targetAuthors.find((targetAuthor) => targetAuthor.platform === sourceAuthor.platform && targetAuthor.eid === sourceAuthor.eid);
                if (matched) {
                    authorMap.set(sourceAuthor.id, matched.id);
                    continue;
                }

                const newAuthorId = crypto.randomUUID();
                await tx.insert(Author).values({
                    id: newAuthorId,
                    library_id: input.target_library_id,
                    eid: sourceAuthor.eid,
                    short_eid: sourceAuthor.short_eid,
                    nickname: sourceAuthor.nickname,
                    signature: sourceAuthor.signature,
                    platform: sourceAuthor.platform,
                    avatar_file_id: null,
                    avatar_thumb_file_id: null,
                    delete_status: DeleteStatus.ACTIVE,
                });
                authorMap.set(sourceAuthor.id, newAuthorId);

                if (sourceAuthor.avatar_file_id || sourceAuthor.avatar_thumb_file_id) {
                    avatarCopyJobs.push({
                        sourceAuthorId: sourceAuthor.id,
                        targetAuthorId: newAuthorId,
                    });
                }
            }
        }

        const postTags =
            input.post_ids.length > 0
                ? await tx
                      .select({
                          post_id: PostTag.post_id,
                          tag_name: Tag.name,
                          tag_normalized: Tag.normalized_name,
                          tag_color: Tag.color,
                          tag_status: Tag.status,
                          tag_source: Tag.source,
                          tag_source_field: Tag.source_field,
                      })
                      .from(PostTag)
                      .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                      .where(inArray(PostTag.post_id, input.post_ids))
                : [];

        const postMediaRows =
            input.post_ids.length > 0 ? await tx.select({ id: Media.id }).from(Media).where(inArray(Media.post_id, input.post_ids)) : [];
        const postMediaIds = postMediaRows.map((media) => media.id);
        const allMovedMediaIds = uniqueIds([...input.media_ids, ...postMediaIds]);

        const mediaTags =
            allMovedMediaIds.length > 0
                ? await tx
                      .select({
                          media_id: MediaTag.media_id,
                          tag_name: Tag.name,
                          tag_normalized: Tag.normalized_name,
                          tag_color: Tag.color,
                          tag_status: Tag.status,
                          tag_source: Tag.source,
                          tag_source_field: Tag.source_field,
                      })
                      .from(MediaTag)
                      .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
                      .where(inArray(MediaTag.media_id, allMovedMediaIds))
                : [];

        const uniqueTagsMap = new Map<
            string,
            {
                name: string;
                color: string | null;
                status: (typeof Tag.$inferSelect)["status"];
                source: (typeof Tag.$inferSelect)["source"];
                sourceField: string | null;
            }
        >();

        for (const tag of [...postTags, ...mediaTags]) {
            if (!uniqueTagsMap.has(tag.tag_normalized)) {
                uniqueTagsMap.set(tag.tag_normalized, {
                    name: tag.tag_name,
                    color: tag.tag_color,
                    status: tag.tag_status,
                    source: tag.tag_source,
                    sourceField: tag.tag_source_field,
                });
            }
        }

        const targetTagMap = new Map<string, string>();
        if (uniqueTagsMap.size > 0) {
            const existingTargetTags = await tx.select().from(Tag).where(eq(Tag.library_id, input.target_library_id));

            for (const [normalizedName, info] of uniqueTagsMap.entries()) {
                const matched = existingTargetTags.find((tag) => tag.normalized_name === normalizedName);
                if (matched) {
                    targetTagMap.set(normalizedName, matched.id);
                    continue;
                }

                const [inserted] = await tx
                    .insert(Tag)
                    .values({
                        name: info.name,
                        normalized_name: normalizedName,
                        color: info.color,
                        library_id: input.target_library_id,
                        status: info.status,
                        source: info.source,
                        source_field: info.sourceField,
                    })
                    .returning({ id: Tag.id });
                if (inserted) {
                    targetTagMap.set(normalizedName, inserted.id);
                }
            }
        }

        let posts = 0;
        let media = 0;
        let postMedia = 0;

        if (input.post_ids.length > 0) {
            for (const post of selectedPosts) {
                await tx
                    .update(Post)
                    .set({
                        library_id: input.target_library_id,
                        author_id: post.author_id ? authorMap.get(post.author_id) || null : null,
                    })
                    .where(eq(Post.id, post.id));
            }
            posts = selectedPosts.length;

            const updatedPostMedia = await tx
                .update(Media)
                .set({ library_id: input.target_library_id })
                .where(inArray(Media.post_id, input.post_ids))
                .returning({ id: Media.id });
            postMedia = updatedPostMedia.length;
        }

        if (input.media_ids.length > 0) {
            const updatedMedia = await tx
                .update(Media)
                .set({ library_id: input.target_library_id })
                .where(and(inArray(Media.id, input.media_ids), isNull(Media.post_id)))
                .returning({ id: Media.id });
            media = updatedMedia.length;
        }

        if (postTags.length > 0) {
            await tx.delete(PostTag).where(inArray(PostTag.post_id, input.post_ids));
            const newPostTags = postTags
                .map((tag) => {
                    const targetId = targetTagMap.get(tag.tag_normalized);
                    return targetId ? { post_id: tag.post_id, tag_id: targetId } : null;
                })
                .filter((tag): tag is { post_id: string; tag_id: string } => !!tag);
            if (newPostTags.length > 0) {
                await tx.insert(PostTag).values(newPostTags);
            }
        }

        if (mediaTags.length > 0) {
            await tx.delete(MediaTag).where(inArray(MediaTag.media_id, allMovedMediaIds));
            const newMediaTags = mediaTags
                .map((tag) => {
                    const targetId = targetTagMap.get(tag.tag_normalized);
                    return targetId ? { media_id: tag.media_id, tag_id: targetId } : null;
                })
                .filter((tag): tag is { media_id: string; tag_id: string } => !!tag);
            if (newMediaTags.length > 0) {
                await tx.insert(MediaTag).values(newMediaTags);
            }
        }

        return { posts, media, post_media: postMedia, avatarCopyJobs };
    });

    if (moved.avatarCopyJobs.length > 0) {
        const uniqueAvatarCopyJobs = Array.from(
            new Map(moved.avatarCopyJobs.map((job) => [`${job.sourceAuthorId}:${job.targetAuthorId}`, job])).values(),
        );
        const unitSpecs = uniqueAvatarCopyJobs.map((job) => ({
            unitKey: `avatar_copy:${job.sourceAuthorId}:${job.targetAuthorId}`,
            kind: AsyncTaskUnitKind.AVATAR_COPY,
            subjectType: AsyncSubjectType.AUTHOR,
            subjectId: job.targetAuthorId,
            inputSnapshot: { sourceAuthorId: job.sourceAuthorId, targetAuthorId: job.targetAuthorId },
        }));

        await JobManager.enqueueTaskWithUnits(
            {
                type: AsyncTaskType.AVATAR_COPY,
                ownerId: auth.ownerId,
                inputSnapshot: { count: uniqueAvatarCopyJobs.length },
            },
            unitSpecs,
        );
    }

    return {
        posts: moved.posts,
        media: moved.media,
        post_media: moved.post_media,
    };
}
