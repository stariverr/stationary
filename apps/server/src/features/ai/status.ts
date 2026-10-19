import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { AssetAiMetadata, DeleteStatus, EntityType, Media, ProcessingStatus } from "@/db/schema";
import { db } from "@/global/db";
import { getLibraryEmbeddingStatus } from "./embedding-spaces";
import { AiService } from "./service";
import type { AiConfigIssue, AiErrorView } from "./types";

export interface DescribeStatusView {
    /** Media the description pipeline has taken up. Library-wide runs only take up media with an image. */
    total: number;
    /** Described with the current prompt version and language. */
    completed: number;
    /** Completed descriptions that another model than the current one wrote. */
    otherModel: number;
    pending: number;
    failed: number;
    /** Latest error of the descriptions still pending or failed. */
    lastError: AiErrorView | null;
}

/** AI health of a library: embedding spaces, descriptions, and bound models that cannot be used. */
export interface LibraryAiStatus extends Awaited<ReturnType<typeof getLibraryEmbeddingStatus>> {
    /** Null when no usable description model is bound. */
    describe: DescribeStatusView | null;
    issues: AiConfigIssue[];
}

const ofActiveMedia = sql`exists (
    select 1 from ${Media}
    where ${Media.id} = ${AssetAiMetadata.entity_id}
      and ${Media.delete_status} = ${DeleteStatus.ACTIVE}
      and ${Media.recycle_time} is null
)`;

/**
 * Description progress of the library under its describe model. A description of an older prompt
 * version or another language counts toward the total but not as completed. Null when no usable
 * description model is bound.
 */
async function getDescribeStatus(libraryId: string, aiService: AiService | null): Promise<DescribeStatusView | null> {
    const target = aiService?.describeTarget;
    if (!target) return null;
    const ofLibrary = and(eq(AssetAiMetadata.library_id, libraryId), eq(AssetAiMetadata.entity_type, EntityType.MEDIA), ofActiveMedia);
    const isStatus = (status: ProcessingStatus) => sql`${AssetAiMetadata.processing_status} = ${status}`;
    const isCurrent = sql`${isStatus(ProcessingStatus.COMPLETED)} and ${AssetAiMetadata.prompt_version} = ${target.promptVersion} and ${AssetAiMetadata.language} = ${target.language}`;
    const [[counts], [latest]] = await Promise.all([
        db
            .select({
                total: sql<number>`count(*)::int`,
                completed: sql<number>`(count(*) filter (where ${isCurrent}))::int`,
                otherModel: sql<number>`(count(*) filter (where ${isCurrent} and ${AssetAiMetadata.model} <> ${target.model}))::int`,
                pending: sql<number>`(count(*) filter (where ${isStatus(ProcessingStatus.PENDING)}))::int`,
                failed: sql<number>`(count(*) filter (where ${isStatus(ProcessingStatus.FAILED)}))::int`,
            })
            .from(AssetAiMetadata)
            .where(ofLibrary),
        db
            .select({ message: AssetAiMetadata.last_error, updated: AssetAiMetadata.update_time, created: AssetAiMetadata.create_time })
            .from(AssetAiMetadata)
            .where(
                and(
                    ofLibrary,
                    inArray(AssetAiMetadata.processing_status, [ProcessingStatus.PENDING, ProcessingStatus.FAILED]),
                    isNotNull(AssetAiMetadata.last_error),
                ),
            )
            .orderBy(sql`coalesce(${AssetAiMetadata.update_time}, ${AssetAiMetadata.create_time}) desc`)
            .limit(1),
    ]);
    return {
        ...counts!,
        lastError: latest?.message ? { message: latest.message, at: (latest.updated ?? latest.created).toString() } : null,
    };
}

/** Null when no usable description model is bound. */
export async function getLibraryDescribeStatus(libraryId: string): Promise<DescribeStatusView | null> {
    return getDescribeStatus(libraryId, await AiService.forLibrary(libraryId));
}

export async function getLibraryAiStatus(libraryId: string): Promise<LibraryAiStatus> {
    const [embedding, aiService] = await Promise.all([getLibraryEmbeddingStatus(libraryId), AiService.forLibrary(libraryId)]);
    return {
        ...embedding,
        describe: await getDescribeStatus(libraryId, aiService),
        issues: aiService?.config.issues ?? [],
    };
}
