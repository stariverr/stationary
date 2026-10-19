import { db } from "@/global/db";
import {
    Post,
    Media,
    AssetSearchDocument,
    AssetAiMetadata,
    ProcessingStatus,
    EntityType,
    ModalityType,
    EmbeddingRole,
    PostTag,
    MediaTag,
    Tag,
    TagStatus,
} from "@/db/schema";
import { eq, and, isNotNull, sql, inArray, or, ne } from "drizzle-orm";
import { enqueueEmbeddings, notifyEmbeddingQueue } from "./embedding-queue";
import { AiService } from "./service";
import { readAiSourceImage, resolveAiImageSource } from "./image-source";
import { classifyAiError, getSafeAiErrorMessage } from "./errors";
import { computeSha256 } from "./utils";
import type { ImageAiMetadata } from "./types";

type EnrichmentPost = Omit<
    Pick<
        typeof Post.$inferSelect,
        "id" | "source" | "eid" | "title" | "description" | "author_name" | "author_external_id" | "url" | "published_time"
    >,
    "id"
> & {
    id: string | null;
};

type StoredAiMetadata = typeof AssetAiMetadata.$inferSelect;

/** How a library-wide enrichment run treats existing descriptions. */
export interface EnrichmentOptions {
    /** Describe again every item whose stored description another model wrote. */
    redescribe?: boolean;
}

const emptyImageMetadata: ImageAiMetadata = {
    caption: "",
    tags: [],
    objects: [],
    colors: [],
    styles: [],
    scene: "",
    ocrText: "",
};

/**
 * The stored description a media item is searched and shown by: the current pipeline's result,
 * otherwise the newest result of an earlier pipeline (e.g. while a language change re-describes the
 * library). Rows without `input_hash` hold no result yet.
 */
export function selectStoredMetadata<
    T extends Pick<StoredAiMetadata, "metadata_pipeline_id" | "input_hash" | "update_time" | "create_time">,
>(rows: T[], currentPipelineId: string | null): T | null {
    const results = rows.filter((row) => row.input_hash !== null);
    const current = results.find((row) => row.metadata_pipeline_id === currentPipelineId);
    if (current) return current;
    const timeOf = (row: T) => (row.update_time ?? row.create_time).epochMilliseconds;
    return results.sort((a, b) => timeOf(b) - timeOf(a))[0] ?? null;
}

/**
 * Whether the stored description of the current pipeline still stands: it was made from the same
 * image and, when `requiredModel` is given, by that model. A model switch alone keeps old descriptions.
 */
export function canReuseDescription(
    stored: Pick<StoredAiMetadata, "input_hash" | "model"> | undefined,
    sourceHash: string | null,
    requiredModel?: string,
): boolean {
    if (!stored || !sourceHash || stored.input_hash !== sourceHash) return false;
    return requiredModel === undefined || stored.model === requiredModel;
}

function toImageAiMetadata(row: StoredAiMetadata): ImageAiMetadata {
    return {
        caption: row.caption,
        tags: row.tags,
        objects: row.objects,
        colors: row.colors,
        styles: row.styles,
        scene: row.scene,
        ocrText: row.ocr_text,
    };
}

/** Searchable text of a media item: one non-empty field per line, duplicates dropped. */
export function buildSearchContent(fields: Array<string | null | undefined>): string {
    return [...new Set(fields.map((field) => field?.trim() ?? "").filter(Boolean))].join("\n");
}

export const AiEnrichmentService = {
    /**
     * Indexes a single Media item and, when the library has AI configured, enriches it from its best
     * available cover or image content.
     *
     * Each artifact is keyed by its own input so unrelated edits never redo expensive work:
     * - image metadata: describe pipeline + source image hash
     * - image embedding: embedding space + source image hash
     * - search document / text embedding: the document text (and the embedding space)
     *
     * The search document is always written, with or without AI: keyword search depends on it, and a
     * failed description must not hide the item. It carries the best stored description; once a new
     * description lands, the document and its text vectors follow. Embeddings are queued for every
     * space the library writes (active and building) and computed in batches by the embedding worker.
     */
    async enrichMediaItem(
        media: typeof Media.$inferSelect,
        post: EnrichmentPost,
        { abortSignal, redescribe }: EnrichmentOptions & { abortSignal?: AbortSignal } = {},
    ): Promise<void> {
        const aiService = await AiService.forLibrary(media.library_id);
        const describeProvider = aiService?.describeProvider ?? null;
        const metadataPipelineId = aiService?.metadataPipelineId ?? null;
        const textSpaces = aiService
            ? [aiService.textEmbedding.active, aiService.textEmbedding.building].filter((provider) => provider !== null)
            : [];
        const imageSpaces = aiService
            ? [aiService.imageEmbedding.active, aiService.imageEmbedding.building].filter((provider) => provider !== null)
            : [];

        const imageSource = describeProvider || imageSpaces.length > 0 ? await resolveAiImageSource(media.id, media.library_id) : null;
        const sourceFile = imageSource?.file;
        const sourceHash = sourceFile ? sourceFile.hash || `file:${sourceFile.id}` : null;

        const storedMetadata = await db
            .select()
            .from(AssetAiMetadata)
            .where(
                and(
                    eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                    eq(AssetAiMetadata.entity_id, media.id),
                    isNotNull(AssetAiMetadata.input_hash),
                ),
            );
        const currentMetadata = storedMetadata.find((row) => row.metadata_pipeline_id === metadataPipelineId);
        const canReuseMetadata = canReuseDescription(currentMetadata, sourceHash, redescribe ? describeProvider?.modelName : undefined);
        const shouldRunDescription = Boolean(describeProvider && sourceFile && !canReuseMetadata);

        let described: ImageAiMetadata | null = null;
        let describeError: unknown = null;

        if (aiService && sourceFile && shouldRunDescription) {
            console.log(`[AI ENRICH] Running image analysis for media ${media.id}...`);
            const imageBuffer = await readAiSourceImage(sourceFile, abortSignal);

            try {
                described = await aiService.describeImage(imageBuffer, sourceFile.mime_type, abortSignal);
            } catch (error) {
                describeError = error;
            }
        }

        const fallbackMetadata = selectStoredMetadata(storedMetadata, metadataPipelineId);
        const aiMetadata = described ?? (fallbackMetadata ? toImageAiMetadata(fallbackMetadata) : emptyImageMetadata);

        // Both direct and canonical tag aliases affect search content.
        const postTagsList = post.id
            ? await db
                  .select({
                      id: Tag.id,
                      name: Tag.name,
                      canonical_tag_id: Tag.canonical_tag_id,
                  })
                  .from(PostTag)
                  .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
                  .where(and(eq(PostTag.post_id, post.id), eq(Tag.status, TagStatus.ACTIVE)))
            : [];
        const postTags = postTagsList.map((pt) => pt.name);

        const mediaTagsList = await db
            .select({
                id: Tag.id,
                name: Tag.name,
                canonical_tag_id: Tag.canonical_tag_id,
            })
            .from(MediaTag)
            .innerJoin(Tag, eq(MediaTag.tag_id, Tag.id))
            .where(and(eq(MediaTag.media_id, media.id), eq(Tag.status, TagStatus.ACTIVE)));
        const mediaTags = mediaTagsList.map((tag) => tag.name);

        const canonicalTagIds = new Set<string>();
        for (const tag of [...postTagsList, ...mediaTagsList]) {
            canonicalTagIds.add(tag.canonical_tag_id || tag.id);
        }

        let allGroupTags: (typeof Tag.$inferSelect)[] = [];
        if (canonicalTagIds.size > 0) {
            const ids = Array.from(canonicalTagIds);
            allGroupTags = await db
                .select()
                .from(Tag)
                .where(and(eq(Tag.status, TagStatus.ACTIVE), or(inArray(Tag.id, ids), inArray(Tag.canonical_tag_id, ids))));
        }

        const allSearchDocTags = Array.from(new Set(allGroupTags.map((t) => t.name)));
        const directTags = new Set([...postTags, ...mediaTags]);
        const tagAliases = allSearchDocTags.filter((name) => !directTags.has(name));

        // Plain values only: field labels would make every document match words like "title" or "tags".
        const searchContent = buildSearchContent([
            media.title,
            media.description,
            post.title,
            post.description,
            postTags.join(", "),
            mediaTags.join(", "),
            tagAliases.join(", "),
            aiMetadata.scene,
            aiMetadata.caption,
            aiMetadata.ocrText,
        ]);

        const searchDocument = {
            library_id: media.library_id,
            source: post.source,
            media_type: media.type,
            title: media.title || post.title || "",
            content: searchContent,
        };
        const documentHash = await computeSha256(JSON.stringify(searchDocument));
        const existingDoc = (
            await db
                .select({ id: AssetSearchDocument.id, content_hash: AssetSearchDocument.content_hash })
                .from(AssetSearchDocument)
                .where(and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), eq(AssetSearchDocument.entity_id, media.id)))
                .limit(1)
        )[0];

        // The document title (media title, else post title) is what both search and embeddings see.
        const textInputHash = await computeSha256(JSON.stringify({ text: searchContent, title: searchDocument.title }));

        const queued = await db.transaction(async (tx) => {
            if (describeProvider && metadataPipelineId) {
                const metadataKey = and(
                    eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                    eq(AssetAiMetadata.entity_id, media.id),
                    eq(AssetAiMetadata.metadata_pipeline_id, metadataPipelineId),
                );
                if (!sourceFile) {
                    await tx
                        .update(AssetAiMetadata)
                        .set({
                            processing_status: ProcessingStatus.FAILED,
                            last_error: "No usable image source is available for AI description",
                            update_time: sql`now()`,
                        })
                        .where(metadataKey);
                } else if (described) {
                    const result = {
                        caption: described.caption,
                        tags: described.tags,
                        objects: described.objects,
                        colors: described.colors,
                        styles: described.styles,
                        scene: described.scene,
                        ocr_text: described.ocrText,
                        model: describeProvider.modelName,
                        input_hash: sourceHash,
                        processing_status: ProcessingStatus.COMPLETED,
                        last_error: null,
                    };
                    await tx
                        .insert(AssetAiMetadata)
                        .values({
                            library_id: media.library_id,
                            entity_type: EntityType.MEDIA,
                            entity_id: media.id,
                            metadata_pipeline_id: metadataPipelineId,
                            ...result,
                        })
                        .onConflictDoUpdate({
                            target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id, AssetAiMetadata.metadata_pipeline_id],
                            set: { ...result, update_time: sql`now()` },
                        });
                    // Results of earlier pipelines (other model, prompt or language) are superseded.
                    await tx
                        .delete(AssetAiMetadata)
                        .where(
                            and(
                                eq(AssetAiMetadata.entity_type, EntityType.MEDIA),
                                eq(AssetAiMetadata.entity_id, media.id),
                                ne(AssetAiMetadata.metadata_pipeline_id, metadataPipelineId),
                            ),
                        );
                } else if (describeError) {
                    // Retryable errors stay PENDING for the task's next attempt; the error shows in the library's AI settings.
                    const failure = {
                        processing_status: classifyAiError(describeError).retryable ? ProcessingStatus.PENDING : ProcessingStatus.FAILED,
                        last_error: getSafeAiErrorMessage(describeError),
                    };
                    await tx
                        .insert(AssetAiMetadata)
                        .values({
                            library_id: media.library_id,
                            entity_type: EntityType.MEDIA,
                            entity_id: media.id,
                            metadata_pipeline_id: metadataPipelineId,
                            model: describeProvider.modelName,
                            ...failure,
                        })
                        .onConflictDoUpdate({
                            target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id, AssetAiMetadata.metadata_pipeline_id],
                            set: { ...failure, update_time: sql`now()` },
                        });
                } else if (canReuseMetadata) {
                    await tx
                        .update(AssetAiMetadata)
                        .set({ processing_status: ProcessingStatus.COMPLETED, last_error: null, update_time: sql`now()` })
                        .where(and(metadataKey, ne(AssetAiMetadata.processing_status, ProcessingStatus.COMPLETED)));
                }
            }

            let documentId = existingDoc?.id;
            if (existingDoc?.content_hash !== documentHash) {
                const docResults = await tx
                    .insert(AssetSearchDocument)
                    .values({
                        entity_type: EntityType.MEDIA,
                        entity_id: media.id,
                        ...searchDocument,
                        content_hash: documentHash,
                    })
                    .onConflictDoUpdate({
                        target: [AssetSearchDocument.entity_type, AssetSearchDocument.entity_id],
                        set: { ...searchDocument, content_hash: documentHash, update_time: sql`now()` },
                    })
                    .returning({ id: AssetSearchDocument.id });
                documentId = docResults[0]?.id;
            }

            return enqueueEmbeddings(tx, [
                ...(sourceHash && sourceFile
                    ? imageSpaces.map((provider) => ({
                          libraryId: media.library_id,
                          mediaId: media.id,
                          role: EmbeddingRole.IMAGE_PRIMARY,
                          modality: ModalityType.IMAGE,
                          spaceId: provider.spaceId,
                          dimension: provider.capabilities.dimension,
                          inputHash: sourceHash,
                          documentId,
                          sourceFileId: sourceFile.id,
                      }))
                    : []),
                ...(searchContent
                    ? textSpaces.map((provider) => ({
                          libraryId: media.library_id,
                          mediaId: media.id,
                          role: EmbeddingRole.AI_CAPTION,
                          modality: ModalityType.TEXT,
                          spaceId: provider.spaceId,
                          dimension: provider.capabilities.dimension,
                          inputHash: textInputHash,
                          documentId,
                          sourceFileId: sourceFile?.id,
                          inputText: searchContent,
                          inputTitle: searchDocument.title,
                      }))
                    : []),
            ]);
        });

        if (queued > 0) await notifyEmbeddingQueue();
        if (describeError) throw describeError;

        console.log(`[AI ENRICH] Completed enrichment for media ${media.id} (${queued} embeddings queued).`);
    },
};
