import { AsyncSubjectType, AsyncTaskUnitKind } from "@/db/schema";
import type { DiscoveredUnitSpec } from "@/infra/jobs/types";

export function buildPostProcessUnitSpecs(input: {
    postId: string;
    mediaIds: readonly string[];
    authorId: string | null;
    avatarUrl?: string | null;
}): DiscoveredUnitSpec[] {
    const units: DiscoveredUnitSpec[] = input.mediaIds.map((mediaId) => ({
        unitKey: `media:${mediaId}`,
        kind: AsyncTaskUnitKind.MEDIA_DOWNLOAD,
        subjectType: AsyncSubjectType.MEDIA,
        subjectId: mediaId,
        inputSnapshot: { post_id: input.postId, media_id: mediaId },
    }));

    if (input.authorId && input.avatarUrl) {
        units.push({
            unitKey: `avatar:${input.authorId}`,
            kind: AsyncTaskUnitKind.AVATAR_DOWNLOAD,
            subjectType: AsyncSubjectType.AUTHOR,
            subjectId: input.authorId,
            inputSnapshot: { author_id: input.authorId, avatar_url: input.avatarUrl },
        });
    }

    return units;
}
