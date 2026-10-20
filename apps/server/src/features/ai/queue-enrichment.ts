import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
    AssetAiMetadata,
    AsyncSubjectType,
    AsyncTaskType,
    AsyncTaskUnitKind,
    DeleteStatus,
    EntityType,
    Library,
    Media,
    ProcessingStatus,
} from "@/db/schema";
import { db } from "@/global/db";
import { JobManager } from "@/infra/jobs/manager";
import { jobRunner } from "@/infra/jobs/runner";
import { AiService } from "./service";
import { QueueAiError } from "./errors";
import type { EnrichmentOptions } from "./enrich";
import type { QueueAiInput } from "./schema";
import type { DescribeTarget } from "./types";

/**
 * Re-processes every media item of a library (pages through them via unit discovery). Used
 * when library-wide inputs change: a new embedding space, or the description language.
 * Unchanged artifacts are reused, so only what actually changed reaches a provider; `redescribe`
 * also replaces descriptions written by another model than the current one.
 */
export async function queueLibraryAiEnrichment(libraryId: string, ownerId: string, options: EnrichmentOptions): Promise<string> {
    const task = await JobManager.createTask({
        type: AsyncTaskType.AI_ENRICH,
        libraryId,
        ownerId,
        inputSnapshot: { scope: "library", redescribe: options.redescribe === true },
    });
    return task.id;
}

export type QueueAiAuth = {
    ownerId: string;
    scopedLibraryId?: string | null;
};

export async function queueAiEnrichment(input: QueueAiInput, auth: QueueAiAuth) {
    const targetMediaIds = new Set<string>();

    if (input.post_ids?.length) {
        const mediaList = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(inArray(Media.post_id, input.post_ids), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
        for (const media of mediaList) {
            targetMediaIds.add(media.id);
        }
    }

    if (input.media_ids?.length) {
        const mediaList = await db
            .select({ id: Media.id })
            .from(Media)
            .where(and(inArray(Media.id, input.media_ids), eq(Media.delete_status, DeleteStatus.ACTIVE), isNull(Media.recycle_time)));
        for (const media of mediaList) {
            targetMediaIds.add(media.id);
        }
    }

    const mediaIds = Array.from(targetMediaIds);
    if (mediaIds.length === 0) {
        return { count: 0, message: "No active media items found to enrich" };
    }

    const mediaList = await db.select({ id: Media.id, library_id: Media.library_id }).from(Media).where(inArray(Media.id, mediaIds));
    const libraryIds = Array.from(new Set(mediaList.map((media) => media.library_id)));

    if (mediaList.length !== mediaIds.length) {
        throw new QueueAiError("INVALID_PARAMETER", "One or more media items were not found or not active");
    }

    const libraries = await db
        .select({ id: Library.id, owner_id: Library.owner_id })
        .from(Library)
        .where(and(inArray(Library.id, libraryIds), eq(Library.delete_status, DeleteStatus.ACTIVE)));

    if (
        libraries.length !== libraryIds.length ||
        libraries.some((library) => library.owner_id !== auth.ownerId) ||
        (auth.scopedLibraryId !== undefined && libraryIds.some((libraryId) => libraryId !== auth.scopedLibraryId))
    ) {
        throw new QueueAiError("FORBIDDEN", "You do not have access to some of the libraries");
    }

    const targetByLibrary = new Map<string, DescribeTarget | null>();
    for (const libraryId of libraryIds) {
        targetByLibrary.set(libraryId, (await AiService.forLibrary(libraryId))?.describeTarget ?? null);
    }

    const masterTask = await db.transaction(async (tx) => {
        for (const media of mediaList) {
            const target = targetByLibrary.get(media.library_id);
            if (!target) continue;

            await tx
                .insert(AssetAiMetadata)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    model: target.model,
                    prompt_version: target.promptVersion,
                    language: target.language,
                    processing_status: ProcessingStatus.PENDING,
                    last_error: null,
                    error_kind: null,
                })
                .onConflictDoUpdate({
                    // An existing row keeps its description, and what it was generated with, until it is replaced.
                    target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id],
                    set: {
                        processing_status: ProcessingStatus.PENDING,
                        last_error: null,
                        error_kind: null,
                        update_time: sql`now()`,
                    },
                });
        }

        return JobManager.enqueueTaskWithUnits(
            {
                type: AsyncTaskType.AI_ENRICH,
                ownerId: auth.ownerId,
                inputSnapshot: { media_ids: mediaIds },
            },
            mediaIds.map((mediaId) => ({
                unitKey: `ai:${mediaId}`,
                kind: AsyncTaskUnitKind.AI_ENRICHMENT,
                subjectType: AsyncSubjectType.MEDIA,
                subjectId: mediaId,
                inputSnapshot: { media_id: mediaId },
            })),
            tx,
        );
    });

    jobRunner.wake();

    return {
        count: mediaIds.length,
        taskId: masterTask.id,
    };
}
