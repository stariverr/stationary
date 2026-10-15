import type { RerankModelCapabilities } from "../model-schema";
import type { RerankProvider, ResolvedModelConfig } from "../types";
import { truncateToTokens } from "../utils";
import { postJson } from "./http";

interface RerankResponse {
    results?: Array<{ index?: number; relevance_score?: number }>;
}

/**
 * The Cohere-style `/rerank` API (`query`, `documents`, `top_n` → `results[].index` and
 * `relevance_score`), implemented by vLLM, Jina, SiliconFlow and other OpenAI-compatible servers.
 */
export class CohereRerankProvider implements RerankProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly capabilities: RerankModelCapabilities;
    private readonly baseUrl: string;
    private readonly apiKey: string;

    constructor(config: ResolvedModelConfig) {
        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = config.capabilities as RerankModelCapabilities;
        this.baseUrl = config.baseUrl.replace(/\/+$/, "");
        this.apiKey = config.apiKey;
    }

    async rerank(query: string, documents: string[], abortSignal?: AbortSignal): Promise<number[]> {
        // Each pair shares the input limit; keep a tenth for the query and formatting.
        const documentBudget = Math.floor(this.capabilities.maxInputTokens * 0.9);
        const res = await postJson<RerankResponse>(`${this.baseUrl}/rerank`, {
            headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
            json: {
                model: this.modelName,
                query,
                documents: documents.map((document) => truncateToTokens(document, documentBudget)),
                top_n: documents.length,
            },
            signal: abortSignal,
        });

        const scores = Array.from({ length: documents.length }, () => Number.NEGATIVE_INFINITY);
        for (const result of res.results ?? []) {
            if (typeof result.index === "number" && typeof result.relevance_score === "number" && result.index < scores.length) {
                scores[result.index] = result.relevance_score;
            }
        }
        return scores;
    }
}
