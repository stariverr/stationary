import { and, asc, eq, gt, inArray, isNull, ne, sql } from "drizzle-orm";
import { AssetEmbedding, AssetSearchDocument, DeleteStatus, EntityType, Media } from "@/db/schema";
import { db } from "@/global/db";
import { markChanged } from "@/infra/queue/changes";
import { Aspect } from "@/infra/queue/pipelines";
import type { SubjectPipelineHandler } from "@/infra/queue/types";
import { buildSearchDocuments } from "./search-document";

const ofMedia = (mediaId: string) => and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), eq(AssetSearchDocument.entity_id, mediaId));

/**
 * `ai.index`: keeps the media's search document in step with its metadata and stored description. Keyword search
 * depends on it with or without AI, so it is written for every active media. It also deletes the vectors a moved media
 * kept from its previous library; the spaces of its new library embed it again.
 *
 * Building a document makes no provider call, so a failure is a bug or a database problem: it is retried, logged and
 * retried again by the next patrol, and not counted as a failure of the media.
 */
export const indexPipeline: SubjectPipelineHandler = {
    async reconcile(ctx) {
        const built = (await buildSearchDocuments([ctx.subjectId])).get(ctx.subjectId);
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

        const stale = existing?.content_hash !== contentHash;
        await db.transaction(async (tx) => {
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
            if (stale) {
                await tx
                    .insert(AssetSearchDocument)
                    .values({ entity_type: EntityType.MEDIA, entity_id: ctx.subjectId, ...document, content_hash: contentHash })
                    .onConflictDoUpdate({
                        target: [AssetSearchDocument.entity_type, AssetSearchDocument.entity_id],
                        set: { ...document, content_hash: contentHash, update_time: sql`now()` },
                    });
            }
            await ctx.fence(tx);
            if (stale) await markChanged(tx, Aspect.MEDIA_SEARCH_DOC, [ctx.subjectId]);
        });
        return { kind: "done" };
    },

    async recordFailure(_tx, { subjectId, error }) {
        console.error(`[AI INDEX] Gave up indexing media ${subjectId}: ${error}`);
    },

    /** Media whose search document is missing or differs from the one they should have now, a moved media's included. */
    async scanPage(libraryId, cursor, limit) {
        const page = await db
            .select({ id: Media.id })
            .from(Media)
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
        const ids = page.map((row) => row.id);
        const [built, stored] = await Promise.all([
            buildSearchDocuments(ids),
            db
                .select({ id: AssetSearchDocument.entity_id, contentHash: AssetSearchDocument.content_hash })
                .from(AssetSearchDocument)
                .where(and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), inArray(AssetSearchDocument.entity_id, ids))),
        ]);
        const storedHash = new Map(stored.map((row) => [row.id, row.contentHash]));
        return {
            subjectIds: ids.filter((id) => built.has(id) && built.get(id)!.contentHash !== storedHash.get(id)),
            nextCursor: page.length === limit ? page[page.length - 1]!.id : null,
        };
    },

    countFailures: async () => new Map(),
    listFailures: async () => [],
};
