import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { EmbeddingModelCapabilities, GeneratedTextModelCapabilities } from "../model-schema";
import type { DescribeImageRequestOptions, LanguageProvider, ResolvedModelConfig } from "../types";
import { guardedFetch } from "./egress";
import { SdkTextEmbeddingProvider } from "./sdk-embedding";

/**
 * Providers speaking the OpenAI wire protocol: OpenAI itself, DashScope's compatible mode,
 * DeepSeek, GLM, Kimi, Mimo, xAI, LiteLLM, and other compatible gateways.
 */
export class OpenAiCompatibleLanguageProvider implements LanguageProvider {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelName: string;
    readonly chatModel: LanguageModel;
    readonly capabilities: GeneratedTextModelCapabilities;
    readonly describeOptions: DescribeImageRequestOptions;

    constructor(config: ResolvedModelConfig) {
        const spec = config.capabilities as GeneratedTextModelCapabilities;

        this.providerId = config.providerId;
        this.providerName = config.providerName;
        this.modelName = config.modelName;
        this.capabilities = spec;
        this.describeOptions = {
            maxOutputTokens: spec.maxOutputTokens,
            reasoning: spec.reasoning,
            providerOptions: spec.options ? { openai: spec.options } : undefined,
            strictJsonSchema: true,
        };

        const openai = createOpenAI({
            apiKey: config.apiKey,
            baseURL: config.baseUrl,
            fetch: guardedFetch as typeof fetch,
        });
        this.chatModel = openai.chat(this.modelName);
    }
}

function embeddingOptions(spec: EmbeddingModelCapabilities) {
    return spec.mrl ? { openai: { dimensions: spec.dimension } } : undefined;
}

function createEmbeddingModel(config: ResolvedModelConfig) {
    return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, fetch: guardedFetch as typeof fetch }).embeddingModel(
        config.modelName,
    );
}

export class OpenAiCompatibleTextEmbeddingProvider extends SdkTextEmbeddingProvider {
    constructor(config: ResolvedModelConfig) {
        super(config, createEmbeddingModel(config), embeddingOptions(config.capabilities as EmbeddingModelCapabilities));
    }
}
