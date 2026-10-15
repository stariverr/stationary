import { AiConfigurationError } from "./errors";
import type { EmbeddingModelCapabilities } from "./model-schema";
import type { EmbedTextParams, EmbeddingResult } from "./types";

export async function computeSha256(str: string): Promise<string> {
    const buf = new TextEncoder().encode(str);
    const hashBuf = await crypto.subtle.digest("SHA-256", buf);
    const hashArray = Array.from(new Uint8Array(hashBuf));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Identifies the vector space an embedding lives in. Vectors are comparable when the model,
 * output dimension and input template match, regardless of which provider served them.
 * Format: {modelName}:{dimension}:{taskPrefixType|plain}
 */
export function computeEmbeddingSpaceId(modelName: string, spec: EmbeddingModelCapabilities): string {
    return `${modelName}:${spec.dimension}:${spec.taskPrefixType ?? "plain"}`;
}

/** Validates a provider vector against the model definition before it can reach the index. */
export function toEmbeddingResult(vector: unknown, modelName: string, spec: EmbeddingModelCapabilities): EmbeddingResult {
    if (!Array.isArray(vector) || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new AiConfigurationError(`Model '${modelName}' returned an invalid embedding.`);
    }
    if (vector.length !== spec.dimension) {
        throw new AiConfigurationError(
            `Model '${modelName}' returned ${vector.length}-dimensional embeddings, but its definition declares ${spec.dimension}.`,
        );
    }
    return {
        embedding: vector,
        spaceId: computeEmbeddingSpaceId(modelName, spec),
        dimension: spec.dimension,
    };
}

const CJK_PATTERN = /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/;

/**
 * Conservative token estimate without a model-specific tokenizer: CJK characters count 1.5,
 * everything else one token per three characters. Real tokenizers usually produce fewer.
 */
export function estimateTokens(text: string): number {
    let tokens = 0;
    for (const char of text) tokens += CJK_PATTERN.test(char) ? 1.5 : 1 / 3;
    return Math.ceil(tokens);
}

/** Cuts `text` so its estimated tokens stay within `maxTokens`, keeping the beginning. */
export function truncateToTokens(text: string, maxTokens: number): string {
    let tokens = 0;
    let end = 0;
    for (const char of text) {
        tokens += CJK_PATTERN.test(char) ? 1.5 : 1 / 3;
        if (tokens > maxTokens) return text.slice(0, end);
        end += char.length;
    }
    return text;
}

/** Share of the model's input limit filled by text, leaving room for estimation error. */
const INPUT_TOKEN_BUDGET = 0.9;

/**
 * Builds the model input: the asymmetric task prefix the model requires (e.g. Gemini retrieval
 * embeddings) around the text, cut to fit the model's input limit. Documents put titles and
 * tags first, so truncation drops the tail (long OCR text) first.
 */
export function formatEmbeddingText(params: EmbedTextParams, spec: EmbeddingModelCapabilities): string {
    const wrap = (text: string) => {
        if (spec.taskPrefixType !== "gemini-asymmetric") return text;
        return params.purpose === "QUERY" ? `task: search result | query: ${text}` : `title: ${params.title || "none"} | text: ${text}`;
    };
    const budget = Math.floor(spec.maxInputTokens * INPUT_TOKEN_BUDGET) - estimateTokens(wrap(""));
    return wrap(truncateToTokens(params.text, Math.max(0, budget)));
}
