import ky from "ky";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { AiProvider, EmbedImageParams, EmbeddingResult } from "../types";

const GEMINI_CHAT_MODEL = "gemini-3.1-flash-lite";
const GEMINI_TEXT_EMBEDDING_MODEL = "gemini-embedding-2";
const GEMINI_MULTIMODAL_EMBEDDING_MODEL = "gemini-embedding-2";
const GEMINI_MULTIMODAL_EMBEDDING_DIMENSION = 1408;

interface GeminiEmbedResponse {
    embedding?: {
        values?: number[];
    };
}

export class GeminiProvider implements AiProvider {
    readonly id = `gemini:${GEMINI_TEXT_EMBEDDING_MODEL}:${GEMINI_MULTIMODAL_EMBEDDING_MODEL}:${GEMINI_CHAT_MODEL}`;
    readonly providerName = "gemini";
    readonly chatModel: LanguageModel;
    readonly chatModelName = GEMINI_CHAT_MODEL;
    readonly textEmbeddingModel: EmbeddingModel;
    readonly textEmbeddingModelName = GEMINI_TEXT_EMBEDDING_MODEL;
    readonly visualEmbeddingModel: EmbeddingModel;
    readonly visualEmbeddingModelName = GEMINI_MULTIMODAL_EMBEDDING_MODEL;
    private apiKey?: string | null;
    private baseUrl?: string | null;
    private google: ReturnType<typeof createGoogleGenerativeAI>;

    constructor(options: { apiKey?: string | null; baseUrl?: string | null } = {}) {
        this.apiKey = options.apiKey;
        this.baseUrl = options.baseUrl;

        this.google = createGoogleGenerativeAI({
            apiKey: this.apiKey || "",
            baseURL: this.baseUrl || "https://generativelanguage.googleapis.com/v1beta",
        });

        this.chatModel = this.google.chat(GEMINI_CHAT_MODEL);
        this.textEmbeddingModel = this.google.embeddingModel(GEMINI_TEXT_EMBEDDING_MODEL);
        this.visualEmbeddingModel = this.google.embeddingModel(GEMINI_MULTIMODAL_EMBEDDING_MODEL);
    }

    private getApiKey(): string {
        const apiKey = this.apiKey;
        if (!apiKey) {
            throw new Error("GEMINI_API_KEY is not configured for this library.");
        }
        return apiKey;
    }

    private getBaseUrl(): string {
        return (this.baseUrl || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
    }

    async embedImage(params: EmbedImageParams): Promise<EmbeddingResult> {
        const apiKey = this.getApiKey();
        const baseUrl = this.getBaseUrl();
        const model = GEMINI_MULTIMODAL_EMBEDDING_MODEL;
        const dimension = GEMINI_MULTIMODAL_EMBEDDING_DIMENSION;
        const spaceId = `${this.providerName}:${model}:${dimension}:cosine:v1`;

        const url = `${baseUrl}/v1beta/models/${model}:embedContent?key=${apiKey}`;
        const base64Data = Buffer.from(params.imageBuffer).toString("base64");

        const requestBody = {
            content: {
                parts: [
                    {
                        inlineData: {
                            mimeType: params.mimeType,
                            data: base64Data,
                        },
                    },
                ],
            },
        };

        const resJson = await ky
            .post(url, {
                json: requestBody,
            })
            .json<GeminiEmbedResponse>();

        const vector = resJson?.embedding?.values;

        if (!Array.isArray(vector)) {
            throw new Error(
                `Invalid response format from Gemini embedImage: ${JSON.stringify(resJson)}`,
            );
        }

        if (vector.length !== dimension) {
            throw new Error(
                `Gemini embedImage dimension mismatch. Expected ${dimension}, got ${vector.length}.`,
            );
        }

        return {
            embedding: vector,
            spaceId,
            dimension,
        };
    }
}
