import {
    findChatModelMetadata,
    findEmbeddingModelMetadata,
    type ChatModelCapabilities,
    type EmbeddingModelCapabilities,
} from "./registry";
import type { EmbedImageParams, EmbedTextParams } from "./types";

export function resolveChatModelCapabilities(
    modelId: string,
    mappedToId?: string | null,
): ChatModelCapabilities {
    if (mappedToId) {
        const refMeta = findChatModelMetadata(mappedToId);
        if (refMeta) return refMeta.capabilities;
    }

    const modelMeta = findChatModelMetadata(modelId);
    if (modelMeta) return modelMeta.capabilities;

    // Default to true for custom/unregistered models to avoid constraining user choice
    return {
        vision: true,
    };
}

export function resolveEmbeddingModelCapabilities(
    modelId: string,
    mappedToId?: string | null,
): EmbeddingModelCapabilities {
    if (mappedToId) {
        const refMeta = findEmbeddingModelMetadata(mappedToId);
        if (refMeta) return refMeta.capabilities;
    }

    const modelMeta = findEmbeddingModelMetadata(modelId);
    if (modelMeta) return modelMeta.capabilities;

    // Default to true for custom/unregistered models to avoid constraining user choice
    return {
        textEmbedding: true,
        imageEmbedding: true,
        embeddingDimension: 0,
    };
}

export function assertVisionCapability(
    modelName: string,
    mappedToId: string | null | undefined,
): void {
    const capabilities = resolveChatModelCapabilities(modelName, mappedToId);
    if (!capabilities.vision) {
        throw new Error(
            `Model "${modelName}" (mapped to "${mappedToId || "none"}") does not support vision capability.`,
        );
    }
}

export function assertTextEmbeddingCapability(
    modelName: string,
    mappedToId: string | null | undefined,
): EmbeddingModelCapabilities {
    const capabilities = resolveEmbeddingModelCapabilities(modelName, mappedToId);
    if (!capabilities.textEmbedding) {
        throw new Error(
            `Model "${modelName}" (mapped to "${mappedToId || "none"}") does not support textEmbedding capability.`,
        );
    }
    return capabilities;
}

export function assertImageEmbeddingCapability(
    modelName: string,
    mappedToId: string | null | undefined,
): EmbeddingModelCapabilities {
    const capabilities = resolveEmbeddingModelCapabilities(modelName, mappedToId);
    if (!capabilities.imageEmbedding) {
        throw new Error(
            `Model "${modelName}" (mapped to "${mappedToId || "none"}") does not support imageEmbedding capability.`,
        );
    }
    return capabilities;
}

export function formatEmbeddingText(
    params: EmbedTextParams,
    capabilities: EmbeddingModelCapabilities,
): string {
    if (capabilities.taskPrefixType !== "gemini-asymmetric") {
        return params.text;
    }

    if (params.purpose === "QUERY") {
        return `task: search result | query: ${params.text}`;
    }

    const titleStr = params.title ? params.title.trim() : "none";
    return `title: ${titleStr} | text: ${params.text}`;
}

export function warnIfTextMayExceedModelLimits(
    text: string,
    capabilities: EmbeddingModelCapabilities,
): void {
    const limits = capabilities.limits;
    if (!limits?.maxTokens) return;

    if (text.length > limits.maxTokens * 6) {
        console.warn(
            `[AiService] Warning: Input text length (${text.length} chars) may exceed model limit of ${limits.maxTokens} tokens.`,
        );
    }
}

export function assertImageWithinModelLimits(
    params: EmbedImageParams,
    capabilities: EmbeddingModelCapabilities,
): void {
    const limits = capabilities.limits;
    if (!limits) return;

    if (limits.maxImageSizeMb) {
        const sizeMb = params.imageBuffer.byteLength / (1024 * 1024);
        if (sizeMb > limits.maxImageSizeMb) {
            throw new Error(
                `Image size (${sizeMb.toFixed(2)} MB) exceeds the model limit of ${limits.maxImageSizeMb} MB.`,
            );
        }
    }

    if (limits.supportedImageFormats) {
        const ext = params.mimeType.split("/")[1]?.toLowerCase();
        const cleanExt = ext === "jpg" ? "jpeg" : ext;
        if (cleanExt && !limits.supportedImageFormats.includes(cleanExt)) {
            throw new Error(
                `Image format "${params.mimeType}" is not supported by this model. Supported formats: ${limits.supportedImageFormats.join(", ")}`,
            );
        }
    }
}
