import ky from "ky";
import type { EmbedImageParams, EmbedTextParams, EmbeddingResult } from "../types";
import { OpenAiProvider } from "./openai";

export class DashScopeProvider extends OpenAiProvider {
    override readonly providerName = "dashscope";

    async embedTextWithVisualModel(params: EmbedTextParams): Promise<EmbeddingResult> {
        const urlObj = new URL(this.baseUrl);
        const requestUrl = `https://${urlObj.hostname}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`;

        const requestBody = {
            model: this.visualEmbeddingModelName,
            input: {
                contents: [
                    {
                        text: params.text,
                    },
                ],
            },
        };

        interface DashScopeEmbeddingResponse {
            output?: {
                embeddings?: Array<{
                    embedding: number[];
                }>;
            };
        }

        const resJson = await ky
            .post(requestUrl, {
                headers: this.getHeaders(),
                json: requestBody,
            })
            .json<DashScopeEmbeddingResponse>();

        const vector = resJson?.output?.embeddings?.[0]?.embedding;

        if (!Array.isArray(vector)) {
            throw new Error(`Invalid response format from DashScope embedTextWithVisualModel: unable to extract embedding vector.`);
        }

        const dimension = vector.length;
        const spaceId = `${this.providerName}:${this.visualEmbeddingModelName}:${dimension}:cosine:v1`;

        return {
            embedding: vector,
            spaceId,
            dimension,
        };
    }

    override async embedImage(params: EmbedImageParams): Promise<EmbeddingResult> {
        const base64Data = Buffer.from(params.imageBuffer).toString("base64");

        const urlObj = new URL(this.baseUrl);
        const requestUrl = `https://${urlObj.hostname}/api/v1/services/embeddings/multimodal-embedding/multimodal-embedding`;

        const requestBody = {
            model: this.visualEmbeddingModelName,
            input: {
                contents: [
                    {
                        image: `data:${params.mimeType};base64,${base64Data}`,
                    },
                ],
            },
        };

        interface DashScopeEmbeddingResponse {
            output?: {
                embeddings?: Array<{
                    embedding: number[];
                }>;
            };
        }

        const resJson = await ky
            .post(requestUrl, {
                headers: this.getHeaders(),
                json: requestBody,
            })
            .json<DashScopeEmbeddingResponse>();

        const vector = resJson?.output?.embeddings?.[0]?.embedding;

        if (!Array.isArray(vector)) {
            throw new Error(`Invalid response format from DashScope embedImage: unable to extract embedding vector.`);
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
