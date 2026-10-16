import { db } from "@/global/db";
import { AssetAiMetadata, EntityType, ProcessingStatus } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { toIsoTimestamp } from "@/lib/utils/time";
import { selectStoredMetadata } from "./enrich";

type StoredAiMetadata = typeof AssetAiMetadata.$inferSelect;

/** AI-generated content of a media item as clients show it. */
export interface MediaAiView {
    status: ProcessingStatus;
    error: string | null;
    result: {
        caption: string;
        tags: string[];
        objects: string[];
        colors: string[];
        styles: string[];
        scene: string;
        ocr_text: string;
        model: string;
        generated_time: string | null;
    } | null;
}

/** Processing status of a media item across its pipeline rows: a completed result wins, then a failure. */
export function summarizeAiStatus(rows: Pick<StoredAiMetadata, "processing_status" | "last_error">[]): {
    status: ProcessingStatus;
    error: string | null;
} {
    const row =
        rows.find((r) => r.processing_status === ProcessingStatus.COMPLETED) ??
        rows.find((r) => r.processing_status === ProcessingStatus.FAILED) ??
        rows[0];
    return { status: row?.processing_status ?? ProcessingStatus.PENDING, error: row?.last_error ?? null };
}

/**
 * The status and stored description of a media item. The description is the newest stored result,
 * which is the current pipeline's once it lands (earlier pipelines' results are deleted then).
 */
export async function getMediaAiView(mediaId: string): Promise<MediaAiView> {
    const rows = await db
        .select()
        .from(AssetAiMetadata)
        .where(and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), eq(AssetAiMetadata.entity_id, mediaId)));
    const stored = selectStoredMetadata(rows, null);
    return {
        ...summarizeAiStatus(rows),
        result: stored
            ? {
                  caption: stored.caption,
                  tags: stored.tags,
                  objects: stored.objects,
                  colors: stored.colors,
                  styles: stored.styles,
                  scene: stored.scene,
                  ocr_text: stored.ocr_text,
                  model: stored.model,
                  generated_time: toIsoTimestamp(stored.update_time ?? stored.create_time),
              }
            : null,
    };
}
