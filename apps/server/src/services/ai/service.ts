import { embed } from "ai";
import {
    assertImageEmbeddingCapability,
    assertImageWithinModelLimits,
    assertTextEmbeddingCapability,
    assertVisionCapability,
    formatEmbeddingText,
    warnIfTextMayExceedModelLimits,
} from "./capabilities";
import { IMAGE_METADATA_PIPELINE_VERSION, describeImageWithModel } from "./image-metadata";
import { resolveAiProvider } from "./resolver";
import type {
    AiProvider,
    AiProviderModelMappings,
    EmbedImageParams,
    EmbedTextParams,
    EmbeddingResult,
    ImageAiMetadata,
} from "./types";

export class AiService {
    constructor(
        readonly provider: AiProvider,
        readonly mappings: AiProviderModelMappings = {},
    ) {}

    static async forLibrary(libraryId: string): Promise<AiService | null> {
        const resolved = await resolveAiProvider({ libraryId });
        if (!resolved) return null;
        return new AiService(resolved.provider, resolved.mappings);
    }

    get providerFingerprint(): string {
        const chatModelName = this.provider.chatModelName;
        const textEmbeddingModelName = this.provider.textEmbeddingModelName;
        const visualEmbeddingModelName = this.provider.visualEmbeddingModelName;

        return [
            this.provider.providerName,
            `provider=${this.provider.id}`,
            `chat=${chatModelName}->${this.mappings.describeImageMapTo || chatModelName}`,
            `text=${textEmbeddingModelName}->${this.mappings.embeddingTextMapTo || textEmbeddingModelName}`,
            `visual=${visualEmbeddingModelName}->${this.mappings.embeddingImageMapTo || visualEmbeddingModelName}`,
        ].join("|");
    }

    get chatModelName(): string | null {
        return this.provider.chatModelName;
    }

    get metadataPipelineId(): string {
        return `${this.provider.providerName}:${this.chatModelName || "none"}:${IMAGE_METADATA_PIPELINE_VERSION}`;
    }

    async embedText(params: EmbedTextParams): Promise<EmbeddingResult> {
        const modelName = this.provider.textEmbeddingModelName;
        if (!modelName) {
            throw new Error(
                `The text embedding model is not configured for AI provider "${this.provider.providerName}".`,
            );
        }
        const mapToId = this.mappings.embeddingTextMapTo;

        const capabilities = assertTextEmbeddingCapability(modelName, mapToId);
        const textValue = formatEmbeddingText(params, capabilities);
        warnIfTextMayExceedModelLimits(textValue, capabilities);

        const model = this.provider.textEmbeddingModel;
        if (!model) {
            throw new Error(
                `The text embedding model is not configured for AI provider "${this.provider.providerName}".`,
            );
        }

        const { embedding } = await embed({
            model,
            value: textValue,
        });

        const dimension = embedding.length;
        const spaceId = `${this.provider.providerName}:${modelName}:${dimension}:cosine:v1`;

        return {
            embedding,
            spaceId,
            dimension,
        };
    }

    async embedTextWithVisualModel(params: EmbedTextParams): Promise<EmbeddingResult> {
        if (typeof this.provider.embedTextWithVisualModel === "function") {
            return this.provider.embedTextWithVisualModel(params);
        }

        const modelName = this.provider.visualEmbeddingModelName;
        if (!modelName) {
            throw new Error(
                `The visual embedding model is not configured for AI provider "${this.provider.providerName}".`,
            );
        }
        const mapToId = this.mappings.embeddingImageMapTo;

        const capabilities = assertTextEmbeddingCapability(modelName, mapToId);
        const textValue = formatEmbeddingText(params, capabilities);
        warnIfTextMayExceedModelLimits(textValue, capabilities);

        const model = this.provider.visualEmbeddingModel;
        if (!model) {
            throw new Error(
                `The visual embedding model is not configured for AI provider "${this.provider.providerName}".`,
            );
        }

        const { embedding } = await embed({
            model,
            value: textValue,
        });

        const dimension = embedding.length;
        const spaceId = `${this.provider.providerName}:${modelName}:${dimension}:cosine:v1`;

        return {
            embedding,
            spaceId,
            dimension,
        };
    }

    async embedImage(params: EmbedImageParams): Promise<EmbeddingResult> {
        const modelName = this.provider.visualEmbeddingModelName;
        if (!modelName) {
            throw new Error(
                `The visual embedding model is not configured for AI provider "${this.provider.providerName}".`,
            );
        }
        const mapToId = this.mappings.embeddingImageMapTo;

        const capabilities = assertImageEmbeddingCapability(modelName, mapToId);
        assertImageWithinModelLimits(params, capabilities);

        return this.provider.embedImage(params);
    }

    async describeImage(
        image: Buffer | Uint8Array | string,
        _mimeType: string,
    ): Promise<ImageAiMetadata> {
        const modelName = this.provider.chatModelName;
        if (!modelName) {
            throw new Error(
                `The chat model for image description is not configured for AI provider "${this.provider.providerName}".`,
            );
        }
        const mapToId = this.mappings.describeImageMapTo;

        assertVisionCapability(modelName, mapToId);
        const model = this.provider.chatModel;
        if (!model) {
            throw new Error(
                `The chat model for image description is not configured for AI provider "${this.provider.providerName}".`,
            );
        }

        return describeImageWithModel(model, image);
    }
}
