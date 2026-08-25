export interface ChatModelCapabilities {
    vision: boolean; // Supports images (describeImage)
}

export interface ChatModelMetadata {
    id: string;
    displayName: string;
    capabilities: ChatModelCapabilities;
}

export interface InputLimits {
    maxTokens?: number;
    maxImageCount?: number;
    maxVideoCount?: number;
    maxAudioCount?: number;
    maxPdfCount?: number;
    maxImageSizeMb?: number;
    maxVideoSizeMb?: number;
    supportedImageFormats?: string[];
    supportedVideoFormats?: string[];
    supportedAudioFormats?: string[];
    totalItemsLimit?: number;
}

export interface FusionSupport {
    supported: boolean;
    paramName?: string; // e.g., "enable_fusion"
    modes?: ("independent" | "fusion")[];
}

export interface EmbeddingModelCapabilities {
    textEmbedding: boolean; // Generates text embeddings
    imageEmbedding: boolean; // Generates visual embeddings
    embeddingDimension: number; // Standard vector dimension
    supportedDimensions?: number[];
    inputModalities?: ("text" | "image" | "video" | "audio" | "pdf")[];
    taskPrefixType?: "gemini-asymmetric" | "none";
    limits?: InputLimits;
    fusion?: FusionSupport;
}

export interface EmbeddingModelMetadata {
    id: string;
    displayName: string;
    capabilities: EmbeddingModelCapabilities;
}

export interface ProviderMetadata {
    id: string;
    displayName: string;
    chatModels: ChatModelMetadata[];
    embeddingModels: EmbeddingModelMetadata[];
}

export const MODEL_REGISTRY: Record<string, ProviderMetadata> = {
    gemini: {
        id: "gemini",
        displayName: "Google Gemini",
        chatModels: [
            {
                id: "gemini-3-flash",
                displayName: "Gemini 3 Flash",
                capabilities: { vision: true },
            },
            {
                id: "gemini-3.5-flash",
                displayName: "Gemini 3.5 Flash",
                capabilities: { vision: true },
            },
            {
                id: "gemini-3.1-pro",
                displayName: "Gemini 3.1 Pro",
                capabilities: { vision: true },
            },
            {
                id: "gemini-3.1-flash-lite",
                displayName: "Gemini 3.1 Flash Lite",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [
            {
                id: "gemini-embedding-2",
                displayName: "Gemini Embedding 2",
                capabilities: {
                    textEmbedding: true,
                    imageEmbedding: true,
                    embeddingDimension: 3072,
                    supportedDimensions: [128, 256, 512, 768, 1024, 1536, 2048, 3072],
                    inputModalities: ["text", "image", "video", "audio", "pdf"],
                    taskPrefixType: "gemini-asymmetric",
                    limits: {
                        maxTokens: 8192,
                        maxImageCount: 6,
                        maxVideoCount: 1,
                        maxPdfCount: 1,
                        supportedImageFormats: ["png", "jpeg"],
                        supportedAudioFormats: ["mp3", "wav"],
                        supportedVideoFormats: ["mp4", "mov"],
                    },
                },
            },
        ],
    },
    openai: {
        id: "openai",
        displayName: "OpenAI",
        chatModels: [
            {
                id: "gpt-5.5",
                displayName: "GPT 5.5",
                capabilities: { vision: true },
            },
            {
                id: "gpt-5.4-mini",
                displayName: "GPT 5.4 Mini",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [
            {
                id: "text-embedding-3-small",
                displayName: "Text Embedding 3 Small",
                capabilities: {
                    textEmbedding: true,
                    imageEmbedding: false,
                    embeddingDimension: 1536,
                    supportedDimensions: [512, 1536],
                    limits: {
                        maxTokens: 8191,
                    },
                },
            },
            {
                id: "text-embedding-3-large",
                displayName: "Text Embedding 3 Large",
                capabilities: {
                    textEmbedding: true,
                    imageEmbedding: false,
                    embeddingDimension: 3072,
                    supportedDimensions: [256, 512, 1024, 1536, 3072],
                    limits: {
                        maxTokens: 8191,
                    },
                },
            },
        ],
    },
    anthropic: {
        id: "anthropic",
        displayName: "Anthropic Claude",
        chatModels: [
            {
                id: "claude-4.8-opus",
                displayName: "Claude Opus 4.8",
                capabilities: { vision: true },
            },
            {
                id: "claude-4.6-sonnet",
                displayName: "Claude Sonnet 4.6",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
    deepseek: {
        id: "deepseek",
        displayName: "DeepSeek",
        chatModels: [
            {
                id: "deepseek-v4-pro",
                displayName: "DeepSeek V4 Pro",
                capabilities: { vision: true },
            },
            {
                id: "deepseek-v4-flash",
                displayName: "DeepSeek V4 Flash",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
    zhipu: {
        id: "zhipu",
        displayName: "Zhipu GLM",
        chatModels: [
            {
                id: "glm-5.1",
                displayName: "GLM 5.1 (glm-5.1)",
                capabilities: { vision: true },
            },
            {
                id: "glm-5-turbo",
                displayName: "GLM 5 Turbo",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
    moonshot: {
        id: "moonshot",
        displayName: "Moonshot Kimi",
        chatModels: [
            {
                id: "kimi-k2.6",
                displayName: "Kimi K2.6",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
    qwen: {
        id: "qwen",
        displayName: "Alibaba Qwen",
        chatModels: [
            {
                id: "qwen-3.7-max",
                displayName: "Qwen 3.7 Max",
                capabilities: { vision: true },
            },
            {
                id: "qwen-3.7-plus",
                displayName: "Qwen 3.7 Plus",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [
            {
                id: "qwen3-embedding",
                displayName: "Qwen3 Embedding",
                capabilities: {
                    textEmbedding: true,
                    imageEmbedding: false,
                    embeddingDimension: 4096,
                    limits: {
                        maxTokens: 32000,
                    },
                },
            },
            {
                id: "qwen3-vl-embedding",
                displayName: "Qwen3 VL Embedding",
                capabilities: {
                    textEmbedding: true,
                    imageEmbedding: true,
                    embeddingDimension: 2560,
                    supportedDimensions: [256, 512, 768, 1024, 1536, 2048, 2560],
                    inputModalities: ["text", "image", "video"],
                    taskPrefixType: "none",
                    limits: {
                        maxTokens: 32000,
                        maxImageSizeMb: 5,
                        maxVideoSizeMb: 50,
                        totalItemsLimit: 20,
                        maxImageCount: 5,
                        maxVideoCount: 1,
                        supportedImageFormats: ["jpeg", "png", "webp", "bmp", "tiff", "ico", "dib", "icns", "sgi"],
                        supportedVideoFormats: ["mp4", "avi", "mov"],
                    },
                    fusion: {
                        supported: true,
                        paramName: "enable_fusion",
                        modes: ["independent", "fusion"],
                    },
                },
            },
        ],
    },
    minimax: {
        id: "minimax",
        displayName: "MiniMax",
        chatModels: [
            {
                id: "minimax-m3",
                displayName: "MiniMax M3",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
    mimo: {
        id: "mimo",
        displayName: "MiMo",
        chatModels: [
            {
                id: "mimo-v2.5-pro",
                displayName: "MiMo V2.5 Pro",
                capabilities: { vision: false },
            },
            {
                id: "mimo-v2.5",
                displayName: "mimo-v2.5",
                capabilities: { vision: true },
            },
        ],
        embeddingModels: [],
    },
};

export function findChatModelMetadata(modelId: string): ChatModelMetadata | null {
    for (const provider of Object.values(MODEL_REGISTRY)) {
        const found = provider.chatModels.find((m) => m.id === modelId);
        if (found) return found;
    }
    return null;
}

export function findEmbeddingModelMetadata(modelId: string): EmbeddingModelMetadata | null {
    for (const provider of Object.values(MODEL_REGISTRY)) {
        const found = provider.embeddingModels.find((m) => m.id === modelId);
        if (found) return found;
    }
    return null;
}
