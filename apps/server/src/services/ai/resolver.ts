import { Library } from "@/db/schema";
import { db } from "@/global/db";
import { eq } from "drizzle-orm";
import { GeminiProvider, OpenAiProvider, DashScopeProvider } from "./providers";
import type { ResolvedAiProvider } from "./types";

interface AiConfigFields {
    aiProvider: string | null;
    openaiApiKey?: string | null;
    openaiBaseUrl?: string | null;
    openaiModelEmbeddingText?: string | null;
    openaiModelEmbeddingTextMapTo?: string | null;
    openaiModelEmbeddingImage?: string | null;
    openaiModelEmbeddingImageMapTo?: string | null;
    openaiModelDescribeImage?: string | null;
    openaiModelDescribeImageMapTo?: string | null;
    geminiApiKey?: string | null;
    geminiBaseUrl?: string | null;
}

function buildResolvedProvider(config: AiConfigFields): ResolvedAiProvider {
    if (config.aiProvider === "openai") {
        const isDashScope =
            config.openaiBaseUrl &&
            (config.openaiBaseUrl.includes("dashscope.aliyuncs.com") ||
                config.openaiBaseUrl.includes("dashscope-intl.aliyuncs.com"));

        const options = {
            apiKey: config.openaiApiKey,
            baseUrl: config.openaiBaseUrl,
            modelEmbeddingText: config.openaiModelEmbeddingText,
            modelEmbeddingImage: config.openaiModelEmbeddingImage,
            modelDescribeImage: config.openaiModelDescribeImage,
        };

        const provider = isDashScope ? new DashScopeProvider(options) : new OpenAiProvider(options);

        return {
            provider,
            mappings: {
                describeImageMapTo: config.openaiModelDescribeImageMapTo,
                embeddingTextMapTo: config.openaiModelEmbeddingTextMapTo,
                embeddingImageMapTo: config.openaiModelEmbeddingImageMapTo,
            },
        };
    }

    return {
        provider: new GeminiProvider({
            apiKey: config.geminiApiKey,
            baseUrl: config.geminiBaseUrl,
        }),
        mappings: {},
    };
}

export async function resolveAiProvider(target: {
    libraryId: string;
}): Promise<ResolvedAiProvider | null> {
    const libraryRows = await db
        .select()
        .from(Library)
        .where(eq(Library.id, target.libraryId))
        .limit(1);
    const library = libraryRows[0];

    if (library && library.ai_provider) {
        return buildResolvedProvider({
            aiProvider: library.ai_provider,
            openaiApiKey: library.openai_api_key,
            openaiBaseUrl: library.openai_base_url,
            openaiModelEmbeddingText: library.openai_model_embedding_text,
            openaiModelEmbeddingTextMapTo: library.openai_model_embedding_text_map_to,
            openaiModelEmbeddingImage: library.openai_model_embedding_image,
            openaiModelEmbeddingImageMapTo: library.openai_model_embedding_image_map_to,
            openaiModelDescribeImage: library.openai_model_describe_image,
            openaiModelDescribeImageMapTo: library.openai_model_describe_image_map_to,
            geminiApiKey: library.gemini_api_key,
            geminiBaseUrl: library.gemini_base_url,
        });
    }

    return null;
}
