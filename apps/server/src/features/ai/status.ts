import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { AssetAiMetadata, DeleteStatus, EntityType, Media, ProcessingStatus } from "@/db/schema";
import { db } from "@/global/db";
import { getLibraryEmbeddingStatus } from "./embedding-spaces";
import { AiService } from "./service";
import type { AiConfigIssue, AiErrorView } from "./types";

export interface DescribeStatusView {
    completed: number;
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

/** Description progress of the library's current pipeline (model, prompt version and language). */
async function getDescribeStatus(libraryId: string, pipelineId: string): Promise<DescribeStatusView> {
    const ofPipeline = and(
        eq(AssetAiMetadata.library_id, libraryId),
        eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
        eq(AssetAiMetadata.metadata_pipeline_id, pipelineId),
        ofActiveMedia,
    );
    const [counts, [latest]] = await Promise.all([
        db
            .select({ status: AssetAiMetadata.processing_status, count: sql<number>`count(*)::int` })
            .from(AssetAiMetadata)
            .where(ofPipeline)
            .groupBy(AssetAiMetadata.processing_status),
        db
            .select({ message: AssetAiMetadata.last_error, updated: AssetAiMetadata.update_time, created: AssetAiMetadata.create_time })
            .from(AssetAiMetadata)
            .where(
                and(
                    ofPipeline,
                    inArray(AssetAiMetadata.processing_status, [ProcessingStatus.PENDING, ProcessingStatus.FAILED]),
                    isNotNull(AssetAiMetadata.last_error),
                ),
            )
            .orderBy(sql`coalesce(${AssetAiMetadata.update_time}, ${AssetAiMetadata.create_time}) desc`)
            .limit(1),
    ]);
    const count = (status: ProcessingStatus) => counts.find((row) => row.status === status)?.count ?? 0;
    return {
        completed: count(ProcessingStatus.COMPLETED),
        pending: count(ProcessingStatus.PENDING),
        failed: count(ProcessingStatus.FAILED),
        lastError: latest?.message ? { message: latest.message, at: (latest.updated ?? latest.created).toString() } : null,
    };
}

/** Null when no usable description model is bound. */
export async function getLibraryDescribeStatus(libraryId: string): Promise<DescribeStatusView | null> {
    const pipelineId = (await AiService.forLibrary(libraryId))?.metadataPipelineId;
    return pipelineId ? getDescribeStatus(libraryId, pipelineId) : null;
}

export async function getLibraryAiStatus(libraryId: string): Promise<LibraryAiStatus> {
    const [embedding, aiService] = await Promise.all([getLibraryEmbeddingStatus(libraryId), AiService.forLibrary(libraryId)]);
    const pipelineId = aiService?.metadataPipelineId;
    return {
        ...embedding,
        describe: pipelineId ? await getDescribeStatus(libraryId, pipelineId) : null,
        issues: aiService?.config.issues ?? [],
    };
}
