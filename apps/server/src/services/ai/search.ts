import { db } from "@/global/db";
import {
    Library,
    Media,
    Track,
    File,
    AssetSearchDocument,
    AssetEmbedding,
    AssetAiMetadata,
    DeleteStatus,
    EmbeddingStatus,
    EntityType,
    TrackType,
    TrackPurpose,
    TrackQuality,
    PostSource,
    MediaType,
} from "@/db/schema";
import { and, eq, inArray, isNull, or, ilike, sql, cosineDistance, lt, SQL } from "drizzle-orm";
import { AiService } from "./service";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";

export interface SearchParams {
    library_id: string;
    keyword: string;
    source?: PostSource;
    media_type?: MediaType;
    page?: number;
    count?: number;
}

export interface SearchResultItem {
    id: string;
    type: string;
    title: string;
    media_url: string | null;
    cover_url?: string | null;
    score: number;
    matched_reason: string;
    matched_details?: {
        keyword?: { matched: boolean };
        text_semantic?: { distance: number; caption?: string | null };
        visual_semantic?: { distance: number; scene?: string | null; styles?: string[] };
    };
    highlights: string[];
    create_time: string | null;
    published_time: string | null;
}

export interface SearchResponse {
    list: SearchResultItem[];
    hasMore: boolean;
    total: number;
}

export const HybridSearchService = {
    /**
     * Resolve all accessible library IDs for the authorized user
     */
    async resolveAccessibleLibraries(userId: string, targetLibraryId?: string): Promise<string[]> {
        const whereConditions = [eq(Library.owner_id, userId), eq(Library.delete_status, DeleteStatus.ACTIVE)];

        if (targetLibraryId) {
            whereConditions.push(eq(Library.id, targetLibraryId));
        }

        const libs = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(...whereConditions));

        return libs.map((l) => l.id);
    },

    /**
     * Executes the hybrid search pipeline
     */
    async search(params: SearchParams, userId: string): Promise<SearchResponse> {
        const page = params.page ?? 1;
        const count = params.count ?? 20;
        const limit = 100; // Get top 100 candidates from each channel for high recall before rank fusion

        // 1. Enforce pre-filtering security bounds on libraries
        const accessibleLibraryIds = await this.resolveAccessibleLibraries(userId, params.library_id);
        if (accessibleLibraryIds.length === 0) {
            return { list: [], hasMore: false, total: 0 };
        }

        const hasQuery = Boolean(params.keyword.trim().length);
        const queryString = params.keyword;

        const aiService = await AiService.forLibrary(params.library_id);
        if (!aiService) {
            throw new Error("AI service not available");
        }

        // Execute retrievals in parallel
        const [keywordRes, textSemanticRes, visualSemanticRes] = await Promise.all([
            hasQuery ? this.keywordSearch(queryString, accessibleLibraryIds, limit, params) : [],
            hasQuery ? this.textSemanticSearch(queryString, accessibleLibraryIds, limit, params, aiService) : [],
            hasQuery ? this.visualSemanticSearch(queryString, accessibleLibraryIds, limit, params, aiService) : [],
        ]);

        // 2. Perform Reciprocal Rank Fusion (RRF)
        // Deduplicate on media ID. RRF formula: 1 / (60 + rank_in_channel) * channel_weight
        const mergedResults = this.reciprocalRankFusion(
            [keywordRes, textSemanticRes, visualSemanticRes],
            { k: 60, weights: [1.0, 1.0, 1.2] }, // Boost visual similarity slightly
        );

        if (mergedResults.length === 0) {
            return { list: [], hasMore: false, total: 0 };
        }

        // 3. Paginate merged candidates
        const offset = (page - 1) * count;
        const paginatedCandidates = mergedResults.slice(offset, offset + count);
        const hasMore = mergedResults.length > offset + count;

        const candidateMediaIds = paginatedCandidates.map((c) => c.mediaId);

        if (candidateMediaIds.length === 0) {
            return { list: [], hasMore, total: mergedResults.length };
        }

        // 4. Fetch additional rich media files and metadata for matching reasons
        const [tracks, aiMetadatas, mediaDetails] = await Promise.all([
            db
                .select({
                    mediaId: Track.media_id,
                    type: Track.type,
                    purpose: Track.purpose,
                    priority: Track.priority,
                    filePath: File.path,
                    fileBucket: File.bucket,
                })
                .from(Track)
                .innerJoin(File, eq(Track.file_id, File.id))
                .where(
                    and(
                        inArray(Track.media_id, candidateMediaIds),
                        or(and(eq(Track.purpose, TrackPurpose.CONTENT), eq(Track.priority, 0)), eq(Track.purpose, TrackPurpose.COVER)),
                        eq(Track.delete_status, DeleteStatus.ACTIVE),
                        eq(File.delete_status, DeleteStatus.ACTIVE),
                    ),
                ),
            db
                .select()
                .from(AssetAiMetadata)
                .where(and(inArray(AssetAiMetadata.entity_id, candidateMediaIds), eq(AssetAiMetadata.entity_type, EntityType.MEDIA))),
            db
                .select({
                    id: Media.id,
                    type: Media.type,
                    create_time: Media.create_time,
                    published_time: Media.published_time,
                })
                .from(Media)
                .where(inArray(Media.id, candidateMediaIds)),
        ]);

        // 5. Structure final result payload with matched reasons
        const list = paginatedCandidates.map((candidate) => {
            const mediaId = candidate.mediaId;
            const mediaInfo = mediaDetails.find((m) => m.id === mediaId);

            // Find media url (CONTENT with priority 0) and cover url (COVER)
            const tracksForMedia = tracks.filter((f) => f.mediaId === mediaId);
            const primaryTrack = tracksForMedia.find(
                (f) =>
                    f.purpose === TrackPurpose.CONTENT &&
                    f.priority === 0 &&
                    (mediaInfo?.type === "VIDEO" ? f.type === TrackType.VIDEO : f.type === TrackType.IMAGE),
            );
            const coverTrack = tracksForMedia.find((f) => f.purpose === TrackPurpose.COVER);

            const mediaUrl = primaryTrack ? buildCdnUrl(primaryTrack.fileBucket, primaryTrack.filePath) : null;

            const coverUrl = coverTrack ? buildCdnUrl(coverTrack.fileBucket, coverTrack.filePath) : null;

            // Resolve matched reason
            const channels = candidate.matchedChannels || [];
            const labels: string[] = [];

            const keywordMatch = channels.find((c) => c.name === "keyword");
            const textMatch = channels.find((c) => c.name === "text_semantic");
            const visualMatch = channels.find((c) => c.name === "visual_semantic");

            if (keywordMatch) {
                labels.push("Keyword Search (FTS/Fuzzy Search)");
            }
            if (textMatch) {
                const distStr = textMatch.distance !== undefined ? ` (Distance: ${textMatch.distance.toFixed(4)})` : "";
                labels.push(`Text Embedding Search${distStr}`);
            }
            if (visualMatch) {
                const distStr = visualMatch.distance !== undefined ? ` (Distance: ${visualMatch.distance.toFixed(4)})` : "";
                labels.push(`Image Embedding Search${distStr}`);
            }

            const metadata = aiMetadatas.find((meta) => meta.entity_id === mediaId);
            let matchedReason = `Matched via: ${labels.join(" + ")}`;
            let highlights: string[] = [];

            if (metadata) {
                const stylesList = metadata.styles.slice(0, 3).join("/");
                const styleSegment = stylesList ? `呈现"${stylesList}"风格` : "";
                const sceneSegment = metadata.scene ? `包含"${metadata.scene}"场景` : "";

                let detailSegment = "";
                if (visualMatch && (sceneSegment || styleSegment)) {
                    detailSegment = ` [${[sceneSegment, styleSegment].filter(Boolean).join("，")}]`;
                }

                let captionSegment = "";
                if (textMatch && metadata.caption) {
                    captionSegment = ` AI描述为: "${metadata.caption}"。`;
                }

                matchedReason = `Matched via: ${labels.join(" + ")}。${detailSegment}${captionSegment}`;
                highlights = [...metadata.tags.slice(0, 4), ...metadata.styles.slice(0, 2)];
            }

            const matchedDetails: any = {};
            if (keywordMatch) {
                matchedDetails.keyword = { matched: true };
            }
            if (textMatch) {
                matchedDetails.text_semantic = {
                    distance: textMatch.distance,
                    caption: metadata?.caption || null,
                };
            }
            if (visualMatch) {
                matchedDetails.visual_semantic = {
                    distance: visualMatch.distance,
                    scene: metadata?.scene || null,
                    styles: metadata?.styles || [],
                };
            }

            return {
                id: mediaId,
                type: mediaInfo?.type || "IMAGE",
                title: candidate.title,
                media_url: mediaUrl,
                cover_url: coverUrl,
                score: parseFloat(candidate.score.toFixed(4)),
                matched_reason: matchedReason,
                matched_details: matchedDetails,
                highlights,
                create_time: mediaInfo ? toIsoTimestamp(mediaInfo.create_time) : null,
                published_time: mediaInfo ? toIsoTimestamp(mediaInfo.published_time) : null,
            };
        });

        return { list, hasMore, total: mergedResults.length };
    },

    /**
     * Trigam index / keyword search pathway
     */
    async keywordSearch(
        query: string,
        accessibleLibraryIds: string[],
        limit: number,
        params: SearchParams,
    ): Promise<Array<{ id: string; title: string }>> {
        const whereClause = [
            eq(Media.delete_status, DeleteStatus.ACTIVE),
            isNull(Media.recycle_time),
            inArray(Media.library_id, accessibleLibraryIds),
            or(ilike(AssetSearchDocument.title, `%${query}%`), ilike(AssetSearchDocument.content, `%${query}%`)),
        ];

        if (params.source) {
            whereClause.push(eq(AssetSearchDocument.source, params.source));
        }
        if (params.media_type) {
            whereClause.push(eq(AssetSearchDocument.media_type, params.media_type));
        }

        const results = await db
            .select({
                id: Media.id,
                title: Media.title,
            })
            .from(AssetSearchDocument)
            .innerJoin(Media, and(eq(AssetSearchDocument.entity_id, Media.id), eq(AssetSearchDocument.entity_type, EntityType.MEDIA)))
            .where(and(...whereClause))
            .limit(limit);

        return results;
    },

    /**
     * Text semantic search pathway (query text -> text vectors)
     */
    async textSemanticSearch(
        query: string,
        accessibleLibraryIds: string[],
        limit: number,
        params: SearchParams,
        aiService: AiService,
    ): Promise<Array<{ id: string; title: string; distance: number }>> {
        try {
            const queryEmbedding = await aiService.embedText({
                text: query,
                purpose: "QUERY",
            });

            const whereClause = [
                eq(AssetEmbedding.embedding_space_id, queryEmbedding.spaceId),
                eq(AssetEmbedding.dimension, queryEmbedding.dimension),
                eq(AssetEmbedding.embedding_status, EmbeddingStatus.READY),
                eq(Media.delete_status, DeleteStatus.ACTIVE),
                isNull(Media.recycle_time),
                inArray(Media.library_id, accessibleLibraryIds),
                lt(cosineDistance(AssetEmbedding.embedding, queryEmbedding.embedding), 0.5),
            ];

            if (params.source) {
                whereClause.push(eq(Media.source, params.source));
            }
            if (params.media_type) {
                whereClause.push(eq(Media.type, params.media_type));
            }

            const results = await db
                .select({
                    id: Media.id,
                    title: Media.title,
                    distance: cosineDistance(AssetEmbedding.embedding, queryEmbedding.embedding) as SQL<number>,
                })
                .from(AssetEmbedding)
                .innerJoin(Media, and(eq(AssetEmbedding.entity_id, Media.id), eq(AssetEmbedding.entity_type, EntityType.MEDIA)))
                .where(and(...whereClause))
                .orderBy(cosineDistance(AssetEmbedding.embedding, queryEmbedding.embedding))
                .limit(limit);

            console.log(
                `[DEBUG AI SEARCH] Text search query "${query}" results (threshold < 0.4):`,
                results.map((r) => `${r.title} (dist: ${r.distance?.toFixed(4)})`),
            );

            return results;
        } catch (e) {
            console.error(`[TEXT SEMANTIC SEARCH FAILED]`, e);
            return [];
        }
    },

    /**
     * Visual semantic search pathway (query text -> image vectors)
     */
    async visualSemanticSearch(
        query: string,
        accessibleLibraryIds: string[],
        limit: number,
        params: SearchParams,
        aiService: AiService,
    ): Promise<Array<{ id: string; title: string; distance: number }>> {
        try {
            const queryRes = await aiService.embedTextWithVisualModel({
                text: query,
                purpose: "QUERY",
            });

            const whereClause = [
                eq(AssetEmbedding.embedding_space_id, queryRes.spaceId),
                eq(AssetEmbedding.dimension, queryRes.dimension),
                eq(AssetEmbedding.embedding_status, EmbeddingStatus.READY),
                eq(Media.delete_status, DeleteStatus.ACTIVE),
                isNull(Media.recycle_time),
                inArray(Media.library_id, accessibleLibraryIds),
                lt(cosineDistance(AssetEmbedding.embedding, queryRes.embedding), 0.6),
            ];

            if (params.source) {
                whereClause.push(eq(Media.source, params.source));
            }
            if (params.media_type) {
                whereClause.push(eq(Media.type, params.media_type));
            }

            const results = await db
                .select({
                    id: Media.id,
                    title: Media.title,
                    distance: cosineDistance(AssetEmbedding.embedding, queryRes.embedding) as SQL<number>,
                })
                .from(AssetEmbedding)
                .innerJoin(Media, and(eq(AssetEmbedding.entity_id, Media.id), eq(AssetEmbedding.entity_type, EntityType.MEDIA)))
                .where(and(...whereClause))
                .orderBy(cosineDistance(AssetEmbedding.embedding, queryRes.embedding))
                .limit(limit);

            console.log(
                `[DEBUG AI SEARCH] Visual search query "${query}" results (threshold < 0.80):`,
                results.map((r) => `${r.title} (dist: ${r.distance?.toFixed(4)})`),
            );

            return results;
        } catch (e) {
            console.error(`[VISUAL SEMANTIC SEARCH FAILED]`, e);
            return [];
        }
    },

    reciprocalRankFusion(
        channels: Array<Array<{ id: string; title: string; distance?: number }>>,
        options: { k: number; weights: number[] },
    ): Array<{
        mediaId: string;
        title: string;
        score: number;
        matchedChannels: Array<{ name: string; distance?: number }>;
    }> {
        const k = options.k;
        const weights = options.weights;
        const channelNames = ["keyword", "text_semantic", "visual_semantic"];

        const scores: Map<
            string,
            {
                title: string;
                score: number;
                matchedChannels: Array<{ name: string; distance?: number }>;
            }
        > = new Map();

        channels.forEach((channel, channelIdx) => {
            const weight = weights[channelIdx] ?? 1.0;
            const channelName = channelNames[channelIdx] || "unknown";

            channel.forEach((item, rank) => {
                const mediaId = item.id;
                const rrfScore = (1 / (k + rank)) * weight;

                const existing = scores.get(mediaId);
                if (existing) {
                    existing.score += rrfScore;
                    if (!existing.matchedChannels.some((c) => c.name === channelName)) {
                        existing.matchedChannels.push({
                            name: channelName,
                            distance: item.distance,
                        });
                    }
                } else {
                    scores.set(mediaId, {
                        title: item.title,
                        score: rrfScore,
                        matchedChannels: [
                            {
                                name: channelName,
                                distance: item.distance,
                            },
                        ],
                    });
                }
            });
        });

        // Convert Map to sorted array
        const sorted = Array.from(scores.entries()).map(([mediaId, val]) => ({
            mediaId,
            title: val.title,
            score: val.score,
            matchedChannels: val.matchedChannels,
        }));

        sorted.sort((a, b) => b.score - a.score);

        return sorted;
    },
};
