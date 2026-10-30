import { db } from "@/global/db";
import { AssetAiMetadata, EntityType } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { toIsoTimestamp } from "@/lib/utils/time";

type StoredAiMetadata = typeof AssetAiMetadata.$inferSelect;

/** FAILED: the last description attempt failed (a stored older description may still be shown). */
export type MediaAiStatus = "PENDING" | "COMPLETED" | "FAILED";

/** AI-generated content of a media item as clients show it. */
export interface MediaAiView {
    status: MediaAiStatus;
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

/** Description status of a media item, read from its result row; one without a description has not been described yet. */
export function summarizeAiStatus(row: Pick<StoredAiMetadata, "input_hash" | "last_error"> | undefined): {
    status: MediaAiStatus;
    error: string | null;
} {
    if (row?.last_error) return { status: "FAILED", error: row.last_error };
    return { status: row?.input_hash ? "COMPLETED" : "PENDING", error: null };
}

/** The status and stored description of a media item. */
export async function getMediaAiView(mediaId: string): Promise<MediaAiView> {
    const [row] = await db
        .select()
        .from(AssetAiMetadata)
        .where(and(eq(AssetAiMetadata.entity_type, EntityType.MEDIA), eq(AssetAiMetadata.entity_id, mediaId)))
        .limit(1);
    const stored = row?.input_hash ? row : null;
    return {
        ...summarizeAiStatus(row),
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
