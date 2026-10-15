/**
 * Model vendors: who publishes a model id, and which catalog provider holds its first-party
 * definition. Gateways and other hosts list the same ids, so a model served by a provider
 * without its own catalog resolves to its vendor's definition through these prefixes.
 */
export interface ModelVendor {
    /** Brand shown when the catalog lists models by vendor. */
    name: string;
    /** Catalog provider (a models.dev provider id) holding the vendor's own definitions. */
    catalogProviderId: string;
    /** Prefixes of the normalized model ids this vendor publishes. */
    prefixes: string[];
    /** Image MIME types the vendor's API documents; models.dev does not publish them. */
    imageFormats?: string[];
}

export const MODEL_VENDORS: ModelVendor[] = [
    { name: "OpenAI", catalogProviderId: "openai", prefixes: ["gpt-", "chatgpt-", "o1", "o3", "o4"], imageFormats: ["image/png", "image/jpeg", "image/webp", "image/gif"] },
    { name: "Anthropic", catalogProviderId: "anthropic", prefixes: ["claude-"], imageFormats: ["image/jpeg", "image/png", "image/gif", "image/webp"] },
    {
        name: "Google", catalogProviderId: "google",
        prefixes: ["gemini-", "gemma-"],
        imageFormats: ["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif"],
    },
    { name: "DeepSeek", catalogProviderId: "deepseek", prefixes: ["deepseek-"] },
    { name: "xAI", catalogProviderId: "xai", prefixes: ["grok-"], imageFormats: ["image/jpeg", "image/png"] },
    {
        name: "Mistral", catalogProviderId: "mistral",
        prefixes: ["mistral-", "ministral-", "pixtral-", "magistral-", "devstral-", "codestral-", "voxtral-"],
    },
    { name: "Qwen", catalogProviderId: "alibaba", prefixes: ["qwen", "qwq-", "qvq-"] },
    { name: "GLM", catalogProviderId: "zhipuai", prefixes: ["glm-"] },
    { name: "Kimi", catalogProviderId: "moonshotai", prefixes: ["kimi-", "moonshot-"] },
    { name: "Xiaomi MiMo", catalogProviderId: "xiaomi", prefixes: ["mimo-"] },
    { name: "MiniMax", catalogProviderId: "minimax", prefixes: ["minimax-"] },
    { name: "StepFun", catalogProviderId: "stepfun", prefixes: ["step-"] },
    { name: "Doubao", catalogProviderId: "volcengine", prefixes: ["doubao-"] },
    { name: "Cohere", catalogProviderId: "cohere", prefixes: ["command-"] },
];

/** The vendor publishing a normalized model id, if known. */
export function findModelVendor(normalizedId: string): ModelVendor | null {
    return MODEL_VENDORS.find((vendor) => vendor.prefixes.some((prefix) => normalizedId.startsWith(prefix))) ?? null;
}
