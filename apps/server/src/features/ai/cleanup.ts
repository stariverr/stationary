import { and, eq, inArray } from "drizzle-orm";
import { AssetAiMetadata, AssetEmbedding, AssetSearchDocument, EntityType } from "@/db/schema";
import type { Transaction } from "@/global/db";

/**
 * Removes everything AI derived from media that are deleted for good: vectors (including queued
 * ones, so no further provider calls are made), search documents and image metadata.
 * Recycled media keep their data so a restore brings search back without reprocessing.
 */
export async function deleteMediaAiData(tx: Transaction, mediaIds: string[]): Promise<void> {
    if (mediaIds.length === 0) return;
    await tx
        .delete(AssetEmbedding)
        .where(and(eq(AssetEmbedding.entity_type, EntityType.MEDIA), inArray(AssetEmbedding.entity_id, mediaIds)));
    await tx
        .delete(AssetSearchDocument)
        .where(and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), inArray(AssetSearchDocument.entity_id, mediaIds)));
    await tx
        .delete(AssetAiMetadata)
        .where(and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), inArray(AssetAiMetadata.entity_id, mediaIds)));
}
