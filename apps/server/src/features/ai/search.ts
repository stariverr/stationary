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
    EmbeddingRole,
    EmbeddingStatus,
    EntityType,
    TrackType,
    TrackPurpose,
    PostSource,
    MediaType,
    searchFold,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { AiService } from "./service";
import { buildCdnUrl } from "@/lib/utils/cdn";
import { toIsoTimestamp } from "@/lib/utils/time";
import { classifyAiError, type AiErrorClassification } from "./errors";
import type { AiBindingRole } from "./model-schema";
import type { EmbeddingResult } from "./types";

/**
 * Cosine distance cut-offs for the semantic channels when the embedding model defines none
 * (`matchDistance`). Text-to-image distances run larger than text-to-text ones.
 */
export const DEFAULT_TEXT_MATCH_DISTANCE = 0.5;
export const DEFAULT_IMAGE_MATCH_DISTANCE = 0.6;

/** How many fused candidates the reranker reorders; the rest keep their fused order. */
const RERANK_CANDIDATES = 50;

interface FusedCandidate {
    mediaId: string;
    title: string;
    score: number;
    matchedChannels: Array<{ name: string; distance?: number }>;
    /** Set when a reranker scored this candidate. */
    rerankScore?: number;
}

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
    matched_details?: {
        keyword?: { matched: boolean };
        text_semantic?: { distance?: number; caption?: string | null };
        visual_semantic?: { distance?: number; scene?: string | null; styles?: string[] };
        rerank?: { score: number };
    };
    highlights: string[];
    create_time: string | null;
    published_time: string | null;
}

export type SearchChannel = "text_semantic" | "visual_semantic" | "rerank";

/** An AI channel that should have taken part in a search but did not, and why. */
export interface SearchDegradation {
    /** `ai` when the library's AI configuration could not be loaded at all. */
    channel: SearchChannel | "ai";
    reason: AiErrorClassification["kind"];
}

export interface SearchResponse {
    list: SearchResultItem[];
    hasMore: boolean;
    total: number;
    /** AI channels that were skipped or failed, so clients can tell users results may be incomplete. */
    degraded: SearchDegradation[];
}

const CHANNEL_FOR_ROLE: Partial<Record<AiBindingRole, SearchChannel>> = {
    textEmbedding: "text_semantic",
    imageEmbedding: "visual_semantic",
    rerank: "rerank",
};

/** Escapes LIKE wildcards so a query matches literally. */
export function escapeLikePattern(text: string): string {
    return text.replace(/[\\%_]/g, "\\$&");
}

/** Escapes regular expression syntax so a term matches literally. */
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MAX_KEYWORD_TERMS = 8;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const SINGLE_HAN = /^\p{Script=Han}$/u;
const SINGLE_HIRAGANA = /^\p{Script=Hiragana}$/u;

/**
 * Splits Chinese or Japanese text into words with ICU. ICU breaks words missing from its dictionary
 * into single Han characters, so adjacent ones are joined back ("赛博朋克"); lone hiragana are
 * particles ("の", "は") and are dropped. Falls back to the whole text when nothing is left.
 */
function segmentUnspaced(text: string): string[] {
    const words: string[] = [];
    let joinable = false;
    for (const { segment, isWordLike } of wordSegmenter.segment(text)) {
        if (!isWordLike || SINGLE_HIRAGANA.test(segment)) {
            joinable = false;
            continue;
        }
        const singleHan = SINGLE_HAN.test(segment);
        if (singleHan && joinable) {
            words[words.length - 1] += segment;
        } else {
            words.push(segment);
        }
        joinable = singleHan;
    }
    return words.length > 0 ? words : [text];
}

/**
 * Splits a query into distinct terms; every term must match. Whitespace (full-width included)
 * separates terms, and Chinese or Japanese runs are segmented further. Terms are NFKC-normalized
 * before LIKE escaping, since NFKC turns full-width ％ and ＿ into wildcards.
 */
export function splitSearchTerms(query: string): string[] {
    const terms = query
        .normalize("NFKC")
        .split(/\s+/)
        .filter((term) => term.length > 0)
        .flatMap((term) => (UNSPACED_SCRIPT.test(term) ? segmentUnspaced(term) : [term]));
    return [...new Set(terms)].slice(0, MAX_KEYWORD_TERMS);
}

/** Folded `LIKE '%text%'` pattern, matching `text` literally. */
function containsPattern(text: string): SQL {
    return searchFold(sql`${`%${escapeLikePattern(text)}%`}::text`);
}

/** Folded regular expression matching `text` as a whole word. */
function wholeWordPattern(text: string): SQL {
    return sql`('\\m' || ${searchFold(sql`${escapeRegExp(text)}::text`)} || '\\M')`;
}

export const HybridSearchService = {
    /** Whether `userId` may search `libraryId`: the library must be active and owned by the user. */
    async canSearchLibrary(userId: string, libraryId: string): Promise<boolean> {
        const rows = await db
            .select({ id: Library.id })
            .from(Library)
            .where(and(eq(Library.id, libraryId), eq(Library.owner_id, userId), eq(Library.delete_status, DeleteStatus.ACTIVE)))
            .limit(1);
        return rows.length > 0;
    },

    /**
     * Executes the hybrid search pipeline
     */
    async search(params: SearchParams, userId: string): Promise<SearchResponse> {
        const page = params.page ?? 1;
        const count = params.count ?? 20;
        const limit = 100; // Get top 100 candidates from each channel for high recall before rank fusion

        // 1. Enforce pre-filtering security bounds on the library
        const libraryId = params.library_id;
        if (!(await this.canSearchLibrary(userId, libraryId))) {
            return { list: [], hasMore: false, total: 0, degraded: [] };
        }

        const hasQuery = Boolean(params.keyword.trim().length);
        const queryString = params.keyword;

        // Resolve the library's AI; without it the search degrades to keyword only, and says so.
        const degraded: SearchDegradation[] = [];
        let aiService: AiService | null = null;
        try {
            aiService = await AiService.forLibrary(libraryId, "interactive");
        } catch (err) {
            console.warn(`[SEARCH] Failed to resolve AI service for library ${libraryId}, degrading to keyword search.`, err);
            if (hasQuery) degraded.push({ channel: "ai", reason: classifyAiError(err).kind });
        }
        if (hasQuery) {
            // Bound models that could not be resolved leave their channel out of this search.
            for (const issue of aiService?.config.issues ?? []) {
                const channel = CHANNEL_FOR_ROLE[issue.role];
                if (channel && !issue.building) degraded.push({ channel, reason: "CONFIGURATION" });
            }
        }

        // Execute retrievals in parallel
        const [keywordRes, textSemanticRes, visualSemanticRes] = await Promise.all([
            hasQuery ? this.keywordSearch(queryString, libraryId, limit, params) : [],
            hasQuery && aiService?.textEmbedding.active
                ? this.textSemanticSearch(queryString, libraryId, limit, params, aiService, degraded)
                : [],
            hasQuery && aiService?.imageEmbedding.active
                ? this.visualSemanticSearch(queryString, libraryId, limit, params, aiService, degraded)
                : [],
        ]);

        // 2. Perform Reciprocal Rank Fusion (RRF)
        // Deduplicate on media ID. RRF formula: channel_weight / (60 + rank_in_channel)
        const mergedResults = this.reciprocalRankFusion(
            [keywordRes, textSemanticRes, visualSemanticRes],
            { k: 60, weights: [1.0, 1.0, 1.2] }, // Boost visual similarity slightly
        );

        if (mergedResults.length === 0) {
            return { list: [], hasMore: false, total: 0, degraded };
        }

        // Fusion ranks by position only; a reranker reads the query against each candidate's text.
        if (hasQuery && aiService?.rerankProvider) {
            await this.rerankTopCandidates(queryString, mergedResults, aiService, degraded);
        }

        // 3. Paginate merged candidates
        const offset = (page - 1) * count;
        const paginatedCandidates = mergedResults.slice(offset, offset + count);
        const hasMore = mergedResults.length > offset + count;

        const candidateMediaIds = paginatedCandidates.map((c) => c.mediaId);

        if (candidateMediaIds.length === 0) {
            return { list: [], hasMore, total: mergedResults.length, degraded };
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

            // Which channels matched; clients render the explanation in the viewer's language.
            const channels = candidate.matchedChannels || [];
            const keywordMatch = channels.find((c) => c.name === "keyword");
            const textMatch = channels.find((c) => c.name === "text_semantic");
            const visualMatch = channels.find((c) => c.name === "visual_semantic");
            const metadata = aiMetadatas.find((meta) => meta.entity_id === mediaId && meta.input_hash !== null);
            const highlights = metadata ? [...metadata.tags.slice(0, 4), ...metadata.styles.slice(0, 2)] : [];

            const matchedDetails: NonNullable<SearchResultItem["matched_details"]> = {};
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

            if (candidate.rerankScore !== undefined && Number.isFinite(candidate.rerankScore)) {
                matchedDetails.rerank = { score: candidate.rerankScore };
            }

            return {
                id: mediaId,
                type: mediaInfo?.type || "IMAGE",
                title: candidate.title,
                media_url: mediaUrl,
                cover_url: coverUrl,
                score: parseFloat(candidate.score.toFixed(4)),
                matched_details: matchedDetails,
                highlights,
                create_time: mediaInfo ? toIsoTimestamp(mediaInfo.create_time) : null,
                published_time: mediaInfo ? toIsoTimestamp(mediaInfo.published_time) : null,
            };
        });

        return { list, hasMore, total: mergedResults.length, degraded };
    },

    /**
     * Keyword pathway: every term of the query (see `splitSearchTerms`) must appear, as a substring
     * of the stored folded title or content (trigram indexed), so "red car" finds "car, red" and "红色跑车"
     * finds "红色的跑车". Ranked so RRF has a meaningful order: the whole query in the title, then
     * terms matched as whole words (so "art" ranks "art" above "start"), terms matched in the
     * title, and the whole query in the content.
     */
    async keywordSearch(
        query: string,
        libraryId: string,
        limit: number,
        params: SearchParams,
    ): Promise<Array<{ id: string; title: string }>> {
        const terms = splitSearchTerms(query);
        if (terms.length === 0) return [];
        const title = AssetSearchDocument.folded_title;
        const content = AssetSearchDocument.folded_content;
        const termPatterns = terms.map(containsPattern);
        const phrasePattern = containsPattern(query.normalize("NFKC").trim());
        const whereClause = [
            eq(Media.delete_status, DeleteStatus.ACTIVE),
            isNull(Media.recycle_time),
            eq(Media.library_id, libraryId),
            // Narrows the scan to the library's documents; Media stays the authority for access.
            eq(AssetSearchDocument.library_id, libraryId),
            ...termPatterns.map((pattern) => sql`(${title} like ${pattern} or ${content} like ${pattern})`),
        ];
        const countOf = (conditions: SQL[]) =>
            sql<number>`(${sql.join(
                conditions.map((condition) => sql`(${condition})::int`),
                sql` + `,
            )})`;
        const wholeWordMatches = countOf(
            terms.map((term) => {
                const pattern = wholeWordPattern(term);
                return sql`${title} ~ ${pattern} or ${content} ~ ${pattern}`;
            }),
        );
        const titleMatches = countOf(termPatterns.map((pattern) => sql`${title} like ${pattern}`));

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
            .orderBy(
                desc(sql`${title} like ${phrasePattern}`),
                desc(wholeWordMatches),
                desc(titleMatches),
                desc(sql`${content} like ${phrasePattern}`),
                desc(Media.create_time),
            )
            .limit(limit);

        return results;
    },

    /**
     * Text semantic search pathway (query text -> document text vectors). A failure is recorded in
     * `degraded` and leaves the channel empty.
     */
    async textSemanticSearch(
        query: string,
        libraryId: string,
        limit: number,
        params: SearchParams,
        aiService: AiService,
        degraded: SearchDegradation[],
    ): Promise<Array<{ id: string; title: string; distance: number }>> {
        try {
            const queryEmbedding = await aiService.embedQuery("textEmbedding", query);
            return await this.vectorSearch(
                queryEmbedding,
                EmbeddingRole.AI_CAPTION,
                aiService.textEmbedding.active?.capabilities.matchDistance?.text ?? DEFAULT_TEXT_MATCH_DISTANCE,
                libraryId,
                limit,
                params,
            );
        } catch (e) {
            console.error(`[TEXT SEMANTIC SEARCH FAILED]`, e);
            degraded.push({ channel: "text_semantic", reason: classifyAiError(e).kind });
            return [];
        }
    },

    /**
     * Visual semantic search pathway (query text -> image vectors). A failure is recorded in
     * `degraded` and leaves the channel empty.
     */
    async visualSemanticSearch(
        query: string,
        libraryId: string,
        limit: number,
        params: SearchParams,
        aiService: AiService,
        degraded: SearchDegradation[],
    ): Promise<Array<{ id: string; title: string; distance: number }>> {
        try {
            const queryEmbedding = await aiService.embedQuery("imageEmbedding", query);
            return await this.vectorSearch(
                queryEmbedding,
                EmbeddingRole.IMAGE_PRIMARY,
                aiService.imageEmbedding.active?.capabilities.matchDistance?.image ?? DEFAULT_IMAGE_MATCH_DISTANCE,
                libraryId,
                limit,
                params,
            );
        } catch (e) {
            console.error(`[VISUAL SEMANTIC SEARCH FAILED]`, e);
            degraded.push({ channel: "visual_semantic", reason: classifyAiError(e).kind });
            return [];
        }
    },

    /**
     * Nearest-neighbour search inside one embedding space and role.
     *
     * The distance expression casts to the literal dimension and filters on it so Postgres can use the
     * matching partial HNSW index (asset_emb_hnsw_{dimension}). The distance cut-off is applied after the
     * top-k scan because a WHERE on distance prevents index ordering.
     */
    async vectorSearch(
        queryEmbedding: EmbeddingResult,
        role: EmbeddingRole,
        maxDistance: number,
        libraryId: string,
        limit: number,
        params: SearchParams,
    ): Promise<Array<{ id: string; title: string; distance: number }>> {
        const dimension = sql.raw(String(queryEmbedding.dimension));
        const distance = sql<number>`(${AssetEmbedding.embedding}::halfvec(${dimension})) <=> ${`[${queryEmbedding.embedding.join(",")}]`}::halfvec(${dimension})`;

        const whereClause = [
            sql`${AssetEmbedding.dimension} = ${dimension}`,
            eq(AssetEmbedding.embedding_space_id, queryEmbedding.spaceId),
            eq(AssetEmbedding.embedding_role, role),
            eq(AssetEmbedding.embedding_status, EmbeddingStatus.READY),
            eq(Media.delete_status, DeleteStatus.ACTIVE),
            isNull(Media.recycle_time),
            eq(Media.library_id, libraryId),
        ];
        if (params.source) {
            whereClause.push(eq(Media.source, params.source));
        }
        if (params.media_type) {
            whereClause.push(eq(Media.type, params.media_type));
        }

        const results = await db.transaction(async (tx) => {
            // ef_search bounds how many rows one HNSW scan can return; iterative scans keep
            // going when the filters above discard candidates (pgvector >= 0.8).
            await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.max(limit, 40)))}`);
            await tx.execute(sql`SET LOCAL hnsw.iterative_scan = relaxed_order`);
            return tx
                .select({ id: Media.id, title: Media.title, distance })
                .from(AssetEmbedding)
                .innerJoin(Media, and(eq(AssetEmbedding.entity_id, Media.id), eq(AssetEmbedding.entity_type, EntityType.MEDIA)))
                .where(and(...whereClause))
                .orderBy(distance)
                .limit(limit);
        });

        // relaxed_order may return rows slightly out of order.
        return results
            .map((row) => ({ ...row, distance: Number(row.distance) }))
            .filter((row) => row.distance < maxDistance)
            .sort((a, b) => a.distance - b.distance);
    },

    /**
     * Reorders the top RERANK_CANDIDATES fused results by reranker score, in place. Candidates
     * beyond that keep their fused order. A failing reranker leaves the fused order untouched and is
     * recorded in `degraded`.
     */
    async rerankTopCandidates(query: string, merged: FusedCandidate[], aiService: AiService, degraded: SearchDegradation[]): Promise<void> {
        const head = merged.slice(0, RERANK_CANDIDATES);
        try {
            const ids = head.map((candidate) => candidate.mediaId);
            const docs = await db
                .select({ id: AssetSearchDocument.entity_id, title: AssetSearchDocument.title, content: AssetSearchDocument.content })
                .from(AssetSearchDocument)
                .where(and(eq(AssetSearchDocument.entity_type, EntityType.MEDIA), inArray(AssetSearchDocument.entity_id, ids)));
            const byId = new Map(docs.map((doc) => [doc.id, doc.content || doc.title]));
            const scores = await aiService.rerank(
                query,
                head.map((candidate) => byId.get(candidate.mediaId) ?? candidate.title ?? ""),
            );
            head.forEach((candidate, index) => {
                candidate.rerankScore = scores[index];
            });
            head.sort((a, b) => (b.rerankScore ?? Number.NEGATIVE_INFINITY) - (a.rerankScore ?? Number.NEGATIVE_INFINITY));
            merged.splice(0, head.length, ...head);
        } catch (error) {
            console.error("[SEARCH] Rerank failed; keeping the fused order.", error);
            degraded.push({ channel: "rerank", reason: classifyAiError(error).kind });
        }
    },

    reciprocalRankFusion(
        channels: Array<Array<{ id: string; title: string; distance?: number }>>,
        options: { k: number; weights: number[] },
    ): FusedCandidate[] {
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

            channel.forEach((item, index) => {
                const mediaId = item.id;
                // RRF ranks are 1-based: score = weight / (k + rank).
                const rrfScore = weight / (k + index + 1);

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
