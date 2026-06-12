import ky from "ky";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, LanguageModel } from "ai";
import type { AiProvider, EmbedImageParams, EmbeddingResult } from "../types";

export interface OpenAiProviderOptions {
    apiKey?: string | null;
    baseUrl?: string | null;
    modelEmbeddingText?: string | null;
    modelEmbeddingImage?: string | null;
    modelDescribeImage?: string | null;
}

interface OpenAiEmbeddingResponse {
    data: Array<{
        embedding: number[];
        index: number;
        object: string;
    }>;
}

export class OpenAiProvider implements AiProvider {
    readonly id: string;
    readonly providerName: string = "openai";
    readonly chatModel: LanguageModel | null;
    readonly chatModelName: string | null;
    readonly textEmbeddingModel: EmbeddingModel | null;
    readonly textEmbeddingModelName: string | null;
    readonly visualEmbeddingModel: EmbeddingModel | null;
    readonly visualEmbeddingModelName: string | null;
    protected apiKey: string;
    protected baseUrl: string;
    private openai: ReturnType<typeof createOpenAI>;

    constructor(options: OpenAiProviderOptions = {}) {
        this.apiKey = options.apiKey || "";
        this.baseUrl = (options.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");

        const modelEmbeddingText = options.modelEmbeddingText?.trim() || null;
        const modelEmbeddingImage = options.modelEmbeddingImage?.trim() || null;
        const modelDescribeImage = options.modelDescribeImage?.trim() || null;

        this.chatModelName = modelDescribeImage;
        this.textEmbeddingModelName = modelEmbeddingText;
        this.visualEmbeddingModelName = modelEmbeddingImage;

        this.id = `openai:${modelEmbeddingText || "none"}:${modelEmbeddingImage || "none"}:${modelDescribeImage || "none"}`;

        this.openai = createOpenAI({
            apiKey: this.apiKey,
            baseURL: this.baseUrl,
        });

        this.chatModel = this.chatModelName ? this.openai.chat(this.chatModelName) : null;
        this.textEmbeddingModel = this.textEmbeddingModelName
            ? this.openai.embeddingModel(this.textEmbeddingModelName)
            : null;
        this.visualEmbeddingModel = this.visualEmbeddingModelName
            ? this.openai.embeddingModel(this.visualEmbeddingModelName)
            : null;
    }

    protected getHeaders() {
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
        };
        if (this.apiKey) {
            headers["Authorization"] = `Bearer ${this.apiKey}`;
        }
        return headers;
    }

    async embedImage(params: EmbedImageParams): Promise<EmbeddingResult> {
        const url = `${this.baseUrl}/embeddings`;
        const base64Data = Buffer.from(params.imageBuffer).toString("base64");

        const requestBody = {
            model: this.visualEmbeddingModelName,
            input: `data:${params.mimeType};base64,${base64Data}`,
        };

        const resJson = await ky
            .post(url, {
                headers: this.getHeaders(),
                json: requestBody,
            })
            .json<OpenAiEmbeddingResponse>();

        const vector = resJson?.data?.[0]?.embedding;

        if (!Array.isArray(vector)) {
            throw new Error(
                `Invalid response format from OpenAI embedImage: ${JSON.stringify(resJson)}`,
            );
        }

        const dimension = vector.length;
        const spaceId = `${this.providerName}:${this.visualEmbeddingModelName}:${dimension}:cosine:v1`;

        return {
            embedding: vector,
            spaceId,
            dimension,
        };
    }
}
