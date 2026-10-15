import type { AiModelCapabilities, AiModelCategory, AiProviderAdapter } from "./model-schema";

/**
 * Provider templates are connection presets. A provider row references its template, which
 * fixes the wire adapter and tells the model catalog where to look up model definitions.
 */
export interface AiProviderTemplate {
    id: string;
    name: string;
    adapter: AiProviderAdapter;
    defaultBaseUrl: string;
    description: string;
    /** Catalog provider (a models.dev provider id) listing the models this endpoint serves. */
    catalogProviderId?: string;
}

export const AI_PROVIDER_TEMPLATES: AiProviderTemplate[] = [
    {
        id: "openai",
        name: "OpenAI",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://api.openai.com/v1",
        description: "OpenAI API",
        catalogProviderId: "openai",
    },
    {
        id: "gemini",
        name: "Google Gemini",
        adapter: "gemini",
        defaultBaseUrl: "https://generativelanguage.googleapis.com",
        description: "Google Generative AI API",
        catalogProviderId: "google",
    },
    {
        id: "dashscope-native",
        name: "Aliyun DashScope (native)",
        adapter: "dashscope-native",
        defaultBaseUrl: "https://dashscope.aliyuncs.com",
        description: "DashScope native multimodal embedding API",
        catalogProviderId: "alibaba-cn",
    },
    {
        id: "dashscope-compatible",
        name: "Aliyun DashScope (OpenAI compatible)",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        description: "DashScope OpenAI-compatible API",
        catalogProviderId: "alibaba-cn",
    },
    {
        id: "deepseek",
        name: "DeepSeek",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://api.deepseek.com/v1",
        description: "DeepSeek OpenAI-compatible API",
        catalogProviderId: "deepseek",
    },
    {
        id: "glm",
        name: "Zhipu AI (GLM)",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
        description: "Zhipu AI OpenAI-compatible API",
        catalogProviderId: "zhipuai",
    },
    {
        id: "kimi",
        name: "Moonshot (Kimi)",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://api.moonshot.cn/v1",
        description: "Moonshot OpenAI-compatible API",
        catalogProviderId: "moonshotai-cn",
    },
    {
        id: "mimo",
        name: "Xiaomi MiMo",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://api.xiaomimimo.com/v1",
        description: "Xiaomi MiMo OpenAI-compatible API",
        catalogProviderId: "xiaomi",
    },
    {
        id: "grok",
        name: "xAI (Grok)",
        adapter: "openai-compatible",
        defaultBaseUrl: "https://api.x.ai/v1",
        description: "xAI OpenAI-compatible API",
        catalogProviderId: "xai",
    },
    {
        id: "custom-openai-compatible",
        name: "Other OpenAI-compatible",
        adapter: "openai-compatible",
        defaultBaseUrl: "",
        description: "Any provider that implements the OpenAI API, including self-hosted servers",
    },
];

export function getProviderTemplate(templateId: string): AiProviderTemplate | null {
    return AI_PROVIDER_TEMPLATES.find((template) => template.id === templateId) ?? null;
}

/**
 * Which model kinds an adapter can serve: the DashScope native adapter only speaks the multimodal
 * embedding API, the OpenAI embeddings protocol has no image input, and rerankers are served through
 * the Cohere-style `/rerank` endpoint of OpenAI-compatible servers.
 */
export function adapterSupportsModel(adapter: AiProviderAdapter, category: AiModelCategory, capabilities: AiModelCapabilities): boolean {
    if (category === "rerank") return adapter === "openai-compatible";
    const multimodalEmbedding = category === "embedding" && "multimodal" in capabilities && capabilities.multimodal;
    if (adapter === "dashscope-native") return multimodalEmbedding;
    if (adapter === "openai-compatible") return !multimodalEmbedding;
    return true;
}
