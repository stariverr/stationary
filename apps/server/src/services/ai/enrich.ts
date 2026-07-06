import { db } from "@/global/db";
import {
    Post,
    Media,
    Track,
    File,
    AssetSearchDocument,
    AssetAiMetadata,
    AssetEmbedding,
    DeleteStatus,
    ProcessingStatus,
    EmbeddingStatus,
    TrackType,
    TrackPurpose,
    MediaType,
    EntityType,
    ModalityType,
    EmbeddingRole,
    Library,
    PostTag,
    Tag,
    TagStatus,
} from "@/db/schema";
import { eq, and, sql, inArray, or } from "drizzle-orm";
import { s3 } from "@/global/s3";
import { AiService } from "./service";
import { computeSha256 } from "./utils";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { env } from "@/global/env";

export const AiEnrichmentService = {
    /**
     * Orchestrates AI enrichment for all completed media items within a Post
     */
    async enrichPost(postId: string): Promise<void> {
        // 1. Fetch Post details
        const postList = await db
            .select()
            .from(Post)
            .where(and(eq(Post.id, postId), eq(Post.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        const post = postList[0];
        if (!post) {
            console.log(`[AI ENRICH] Post ${postId} not found or inactive. Skipping.`);
            return;
        }

        // 2. Fetch active Media records for the Post
        const mediaList = await db
            .select()
            .from(Media)
            .where(and(eq(Media.post_id, postId), eq(Media.delete_status, DeleteStatus.ACTIVE)));

        console.log(`[AI ENRICH] Enriching post ${postId} containing ${mediaList.length} active media items.`);

        for (const m of mediaList) {
            try {
                await this.enrichMediaItem(m, post);
            } catch (err) {
                console.error(`[AI ENRICH] Failed to enrich media item ${m.id}:`, err);
            }
        }
    },

    /**
     * Enrich a single Media item (Image or Video Cover)
     */
    async enrichMediaItem(media: typeof Media.$inferSelect, post: typeof Post.$inferSelect): Promise<void> {
        // 1. Resolve targeted Track (COVER for Videos, CONTENT IMAGE for others)
        const isVideo = media.type === MediaType.VIDEO;
        const trackType = TrackType.IMAGE;
        const trackPurpose = isVideo ? TrackPurpose.COVER : TrackPurpose.CONTENT;

        // Fetch Library to resolve owner_id
        const libraryRows = await db.select().from(Library).where(eq(Library.id, media.library_id)).limit(1);
        const library = libraryRows[0];
        if (!library) {
            console.log(`[AI ENRICH] Target library not found for media ${media.id}. skipping.`);
            return;
        }

        const aiService = await AiService.forLibrary(media.library_id);
        if (!aiService) {
            console.log(`[AI ENRICH] AI is not configured for library ${media.library_id}. Skipping.`);
            return;
        }
        const metadataPipelineId = aiService.metadataPipelineId;

        const track = await db.query.Track.findFirst({
            where: {
                media_id: media.id,
                type: trackType,
                purpose: trackPurpose,
                priority: 0,
                delete_status: DeleteStatus.ACTIVE,
            },
        });

        if (!track || !track.file_id) {
            console.log(`[AI ENRICH] Target file not found/completed for media ${media.id} (${trackType}:${trackPurpose}). skipping.`);
            return;
        }

        const file = await db.query.File.findFirst({
            where: {
                id: track.file_id,
                delete_status: DeleteStatus.ACTIVE,
            },
        });

        if (!file) {
            console.log(`[AI ENRICH] Physical S3 file ${track.file_id} not found in DB for media ${media.id}. skipping.`);
            return;
        }

        // 2. Calculate content hash for strict idempotency
        // If content is unmodified, we bypass expensive LLM/VLM calls entirely.
        const sourceHashInput = `${file.hash || file.id}:${media.title}:${media.description}:${metadataPipelineId}:${aiService.providerFingerprint}`;
        const contentHash = await computeSha256(sourceHashInput);

        // Fetch relational tags of the post for search document indexing
        const postTagsList = await db
            .select({
                id: Tag.id,
                name: Tag.name,
                canonical_tag_id: Tag.canonical_tag_id,
            })
            .from(PostTag)
            .innerJoin(Tag, eq(PostTag.tag_id, Tag.id))
            .where(and(eq(PostTag.post_id, post.id), eq(Tag.status, TagStatus.ACTIVE)));
        const postTags = postTagsList.map((pt) => pt.name);

        const canonicalTagIds = new Set<string>();
        for (const pt of postTagsList) {
            if (pt.canonical_tag_id) {
                canonicalTagIds.add(pt.canonical_tag_id);
            } else {
                canonicalTagIds.add(pt.id);
            }
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
        const postTagAliases = allSearchDocTags.filter((name) => !postTags.includes(name));

        // 3. Verify if active indexing documents already match this content hash
        const existingDoc = await db.query.AssetSearchDocument.findFirst({
            where: {
                entity_type: EntityType.MEDIA,
                entity_id: media.id,
                content_hash: contentHash,
            },
        });

        if (existingDoc) {
            console.log(`[AI ENRICH] Media item ${media.id} is already enriched and up-to-date (hash match). Skipping.`);
            return;
        }

        console.log(`[AI ENRICH] Running AI Analysis pipeline for Media ${media.id}...`);

        // 4. Download private file buffer from S3 via secure short-lived presigned URL
        const presignedUrl = await s3.getPresignedUrl(file.path, {
            bucket: file.bucket,
            expiresInSeconds: 600, // 10 minutes
        });

        const downloadResponse = await fetch(presignedUrl);
        if (!downloadResponse.ok) {
            throw new Error(`Failed to download physical file from S3: ${downloadResponse.statusText}`);
        }

        const arrayBuffer = await downloadResponse.arrayBuffer();
        const imageBuffer = new Uint8Array(arrayBuffer);

        // 5. Determine whether to pass public CDN URL or fallback to local buffer
        const cdnUrl = buildCdnUrl(file.bucket, file.path);
        let describeInput: Buffer | Uint8Array | string = imageBuffer;

        const storageIsPublic = env.STORAGE_IS_PUBLIC;
        if (storageIsPublic && cdnUrl) {
            describeInput = cdnUrl;
            console.log(`[AI ENRICH] Passing public CDN URL to describeImage: ${cdnUrl}`);
        } else {
            console.log(`[AI ENRICH] Fallback to buffer. storageIsPublic: ${storageIsPublic}, cdnUrl: ${cdnUrl}`);
        }

        /** Image Metadata by AI */
        const aiMetadata = await aiService.describeImage(describeInput, file.mime_type);

        /** Image Embedding Vectors */
        const imageEmbeddingResult = await aiService.embedImage({
            imageBuffer,
            mimeType: file.mime_type,
        });

        // 7. Prepare combined text mapping for FTS indexing and text-embedding
        const combinedFtsContent =
            `Media Title: ${media.title || ""}\n` +
            `Media Description: ${media.description || ""}\n` +
            `Post Title: ${post.title || ""}\n` +
            `Post Description: ${post.description || ""}\n` +
            `Post Tags: ${postTags.join(", ")}\n` +
            `Post Tag Aliases: ${postTagAliases.join(", ")}\n` +
            `AI Scene: ${aiMetadata.scene}\n` +
            `AI Caption: ${aiMetadata.caption}\n` +
            `OCR: ${aiMetadata.ocrText}`;

        /** Text Embedding Vectors */
        const textEmbeddingResult = await aiService.embedText({
            text: combinedFtsContent,
            purpose: "DOCUMENT",
            title: media.title || undefined,
        });

        // 9. Save all structures inside a transactional atomic commit
        await db.transaction(async (tx) => {
            // Write AI metadata
            await tx
                .insert(AssetAiMetadata)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    caption: aiMetadata.caption,
                    summary: aiMetadata.caption, // Summary fallback
                    tags: aiMetadata.tags,
                    objects: aiMetadata.objects,
                    colors: aiMetadata.colors,
                    styles: aiMetadata.styles,
                    scene: aiMetadata.scene,
                    ocr_text: aiMetadata.ocrText,
                    model: aiService.chatModelName || "none",
                    metadata_pipeline_id: metadataPipelineId,
                    processing_status: ProcessingStatus.COMPLETED,
                })
                .onConflictDoUpdate({
                    target: [AssetAiMetadata.entity_type, AssetAiMetadata.entity_id, AssetAiMetadata.metadata_pipeline_id],
                    set: {
                        caption: aiMetadata.caption,
                        summary: aiMetadata.caption,
                        tags: aiMetadata.tags,
                        objects: aiMetadata.objects,
                        colors: aiMetadata.colors,
                        styles: aiMetadata.styles,
                        scene: aiMetadata.scene,
                        ocr_text: aiMetadata.ocrText,
                        processing_status: ProcessingStatus.COMPLETED,
                        update_time: sql`now()`,
                    },
                });

            // Write Search Document for GIN trigram / keyword matching
            const docResults = await tx
                .insert(AssetSearchDocument)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    source: post.source,
                    media_type: media.type,
                    title: media.title || post.title || "",
                    content: combinedFtsContent,
                    tags: allSearchDocTags,
                    ai_tags: aiMetadata.tags,
                    author_name: post.author_name,
                    published_time: media.published_time,
                    content_hash: contentHash,
                })
                .onConflictDoUpdate({
                    target: [AssetSearchDocument.entity_type, AssetSearchDocument.entity_id],
                    set: {
                        library_id: media.library_id,
                        source: post.source,
                        media_type: media.type,
                        title: media.title || post.title || "",
                        content: combinedFtsContent,
                        tags: allSearchDocTags,
                        ai_tags: aiMetadata.tags,
                        author_name: post.author_name,
                        published_time: media.published_time,
                        content_hash: contentHash,
                        update_time: sql`now()`,
                    },
                })
                .returning({ id: AssetSearchDocument.id });

            const docId = docResults[0]?.id;

            // Write Image Embedding
            await tx
                .insert(AssetEmbedding)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    document_id: docId,
                    embedding_space_id: imageEmbeddingResult.spaceId,
                    embedding_role: EmbeddingRole.IMAGE_PRIMARY,
                    input_modality: ModalityType.IMAGE,
                    dimension: imageEmbeddingResult.dimension,
                    embedding: imageEmbeddingResult.embedding,
                    content_hash: contentHash,
                    source_file_id: file.id,
                    embedding_status: EmbeddingStatus.READY,
                })
                .onConflictDoUpdate({
                    target: [
                        AssetEmbedding.entity_type,
                        AssetEmbedding.entity_id,
                        AssetEmbedding.embedding_space_id,
                        AssetEmbedding.embedding_role,
                        AssetEmbedding.content_hash,
                    ],
                    set: {
                        library_id: media.library_id,
                        document_id: docId,
                        embedding: imageEmbeddingResult.embedding,
                        source_file_id: file.id,
                        embedding_status: EmbeddingStatus.READY,
                        update_time: sql`now()`,
                    },
                });

            // Write Text Embedding
            await tx
                .insert(AssetEmbedding)
                .values({
                    library_id: media.library_id,
                    entity_type: EntityType.MEDIA,
                    entity_id: media.id,
                    document_id: docId,
                    embedding_space_id: textEmbeddingResult.spaceId,
                    embedding_role: EmbeddingRole.AI_CAPTION,
                    input_modality: ModalityType.TEXT,
                    dimension: textEmbeddingResult.dimension,
                    embedding: textEmbeddingResult.embedding,
                    content_hash: contentHash,
                    source_file_id: file.id,
                    embedding_status: EmbeddingStatus.READY,
                })
                .onConflictDoUpdate({
                    target: [
                        AssetEmbedding.entity_type,
                        AssetEmbedding.entity_id,
                        AssetEmbedding.embedding_space_id,
                        AssetEmbedding.embedding_role,
                        AssetEmbedding.content_hash,
                    ],
                    set: {
                        library_id: media.library_id,
                        document_id: docId,
                        embedding: textEmbeddingResult.embedding,
                        source_file_id: file.id,
                        embedding_status: EmbeddingStatus.READY,
                        update_time: sql`now()`,
                    },
                });
        });

        console.log(`[AI ENRICH] Successfully completed AI enrichment for media ${media.id}.`);
    },
};
