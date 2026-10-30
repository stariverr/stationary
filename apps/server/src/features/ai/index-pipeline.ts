import { and, asc, eq, gt, isNull, ne, sql } from "drizzle-orm";
import { AssetEmbedding, AssetSearchDocument, DeleteStatus, EntityType, Media } from "@/db/schema";
import { db } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { SubjectPipelineHandler } from "@/infra/queue/types";
import { buildSearchDocument } from "./search-document";

const ofMedia = (mediaId: string) => and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), eq(AssetSearchDocument.entity_id, mediaId));

/**
 * `ai.index`: keeps the media's search document in step with its metadata and stored description. Keyword search
 * depends on it with or without AI, so it is written for every active media. It also deletes the vectors a moved media
 * kept from its previous library (§11.13 #2); the spaces of its new library embed it again.
 *
 * Building a document makes no provider call, so a failure is a bug or a database problem: it is retried and logged,
 * and not counted as a failure of the media.
 */
export const indexPipeline: SubjectPipelineHandler = {
    async reconcile(ctx) {
        const built = await buildSearchDocument(ctx.subjectId);
        if (!built) return { kind: "done" };
        const { document, contentHash } = built;

        const [existing] = await db
            .select({ content_hash: AssetSearchDocument.content_hash })
            .from(AssetSearchDocument)
            .where(ofMedia(ctx.subjectId))
            .limit(1);
        const [foreignVector] = await db
            .select({ id: AssetEmbedding.id })
            .from(AssetEmbedding)
            .where(
                and(
                    eq(AssetEmbedding.entity_type, EntityType.MEDIA),
                    eq(AssetEmbedding.entity_id, ctx.subjectId),
                    ne(AssetEmbedding.library_id, document.library_id),
                ),
            )
            .limit(1);
        if (existing?.content_hash === contentHash && !foreignVector) return { kind: "done" };

        await db.transaction(async (tx) => {
            await ctx.fence(tx);
            if (foreignVector) {
                await tx
                    .delete(AssetEmbedding)
                    .where(
                        and(
                            eq(AssetEmbedding.entity_type, EntityType.MEDIA),
                            eq(AssetEmbedding.entity_id, ctx.subjectId),
                            ne(AssetEmbedding.library_id, document.library_id),
                        ),
                    );
            }
            if (existing?.content_hash === contentHash) return;
            await tx
                .insert(AssetSearchDocument)
                .values({ entity_type: EntityType.MEDIA, entity_id: ctx.subjectId, ...document, content_hash: contentHash })
                .onConflictDoUpdate({
                    target: [AssetSearchDocument.entity_type, AssetSearchDocument.entity_id],
                    set: { ...document, content_hash: contentHash, update_time: sql`now()` },
                });
            await markChanged(tx, Aspect.MEDIA_SEARCH_DOC, [ctx.subjectId]);
        });
        return { kind: "done" };
    },

    async recordFailure(_tx, { subjectId, error }) {
        console.error(`[AI INDEX] Gave up indexing media ${subjectId}: ${error}`);
    },

    /** Media without a search document, or with one of another library. Edits reach the pipeline through markChanged. */
    async scanPage(libraryId, cursor, limit) {
        const page = await db
            .select({ id: Media.id, indexed: sql<boolean>`${AssetSearchDocument.library_id} = ${libraryId}` })
            .from(Media)
            .leftJoin(
                AssetSearchDocument,
                and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), eq(AssetSearchDocument.entity_id, Media.id)),
            )
            .where(
                and(
                    eq(Media.library_id, libraryId),
                    eq(Media.delete_status, DeleteStatus.ACTIVE),
                    isNull(Media.recycle_time),
                    ...(cursor ? [gt(Media.id, cursor)] : []),
                ),
            )
            .orderBy(asc(Media.id))
            .limit(limit);
        return {
            subjectIds: page.filter((row) => !row.indexed).map((row) => row.id),
            nextCursor: page.length === limit ? page[page.length - 1]!.id : null,
        };
    },

    countFailures: async () => new Map(),
    listFailures: async () => [],
};
