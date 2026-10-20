import { and, eq, sql } from "drizzle-orm";
import { AssetAiMetadata, DeleteStatus, EntityType, Media, ProcessingStatus } from "@/db/schema";
import { db } from "@/global/db";
import { getCoverageTargets, getLibraryAiProgress, getLibraryCoverage, type LibraryAiProgress, type LibraryCoverage } from "./coverage";
import { getLibraryEmbeddingStatus } from "./embedding-spaces";
import { AiService } from "./service";
import type { AiConfigIssue } from "./types";

export interface DescribeStatusView {
    /** Prompt version descriptions are written with now. */
    promptVersion: string;
    /** Items with a description in the library's language. */
    described: number;
    /** Described items another model or an older prompt version wrote; still usable, and "update" replaces them. */
    updatable: number;
    /** Of `updatable`, those written with an older prompt version. */
    olderVersion: number;
    pending: number;
    failed: number;
}

/** AI health of a library: what search covers, running work, per-role details and bound models that cannot be used. */
export interface LibraryAiStatus extends Awaited<ReturnType<typeof getLibraryEmbeddingStatus>> {
    /** Null when no AI role is usable. */
    coverage: LibraryCoverage | null;
    progress: LibraryAiProgress;
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

async function getDescribeStatus(libraryId: string, aiService: AiService | null): Promise<DescribeStatusView | null> {
    const target = aiService?.describeTarget;
    if (!target) return null;
    const isStatus = (status: ProcessingStatus) => sql`${AssetAiMetadata.processing_status} = ${status}`;
    const isDescribed = sql`${AssetAiMetadata.input_hash} is not null and ${AssetAiMetadata.language} = ${target.language}`;
    const isOlderVersion = sql`${AssetAiMetadata.prompt_version} <> ${target.promptVersion}`;
    const [counts] = await db
        .select({
            described: sql<number>`(count(*) filter (where ${isDescribed}))::int`,
            updatable: sql<number>`(count(*) filter (where ${isDescribed} and (${isOlderVersion} or ${AssetAiMetadata.model} <> ${target.model})))::int`,
            olderVersion: sql<number>`(count(*) filter (where ${isDescribed} and ${isOlderVersion}))::int`,
            pending: sql<number>`(count(*) filter (where ${isStatus(ProcessingStatus.PENDING)}))::int`,
            failed: sql<number>`(count(*) filter (where ${isStatus(ProcessingStatus.FAILED)}))::int`,
        })
        .from(AssetAiMetadata)
        .where(and(eq(AssetAiMetadata.library_id, libraryId), eq(AssetAiMetadata.entity_type, EntityType.MEDIA), ofActiveMedia));
    return { promptVersion: target.promptVersion, ...counts! };
}

export async function getLibraryAiStatus(libraryId: string): Promise<LibraryAiStatus> {
    const aiService = await AiService.forLibrary(libraryId);
    const targets = getCoverageTargets(aiService);
    const [embedding, coverage, progress, describe] = await Promise.all([
        getLibraryEmbeddingStatus(libraryId),
        targets ? getLibraryCoverage(libraryId, targets) : null,
        getLibraryAiProgress(libraryId),
        getDescribeStatus(libraryId, aiService),
    ]);
    return { ...embedding, coverage, progress, describe, issues: aiService?.config.issues ?? [] };
}
