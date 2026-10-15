import type { AiProviderAdapter } from "../model-schema";
import { geminiApiBaseUrl } from "./gemini";
import { getJson } from "./http";

export interface ProviderConnection {
    adapter: AiProviderAdapter;
    baseUrl: string;
    apiKey: string;
}

function dashScopeCompatibleBaseUrl(baseUrl: string): string {
    const host = baseUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return `https://${host}/compatible-mode/v1`;
}

/**
 * Verifies a connection by listing the provider's models. A success proves the endpoint and
 * credential work; the returned ids help users pick model names.
 */
export async function listProviderModels(connection: ProviderConnection, signal?: AbortSignal): Promise<string[]> {
    if (connection.adapter === "gemini") {
        const res = await getJson<{ models?: Array<{ name?: string }> }>(`${geminiApiBaseUrl(connection.baseUrl)}/models?pageSize=1000`, {
            headers: { "x-goog-api-key": connection.apiKey },
            signal,
        });
        return (res.models ?? []).flatMap((model) => (model.name ? [model.name.replace(/^models\//, "")] : []));
    }

    // DashScope native shares credentials with its OpenAI-compatible endpoint, which can list models.
    const baseUrl =
        connection.adapter === "dashscope-native" ? dashScopeCompatibleBaseUrl(connection.baseUrl) : connection.baseUrl.replace(/\/+$/, "");
    const res = await getJson<{ data?: Array<{ id?: string }> }>(`${baseUrl}/models`, {
        headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
        signal,
    });
    return (res.data ?? []).flatMap((model) => (model.id ? [model.id] : []));
}
