import { HTTPError, NetworkError, TimeoutError, default as ky } from "ky";
import { AiProviderError, getSafeAiErrorMessage, parseRetryAfterHeader, type AiProviderErrorKind } from "../errors";
import { guardedFetch } from "./egress";

export interface RequestJsonOptions {
    headers?: Record<string, string>;
    json?: unknown;
    timeout?: number;
    signal?: AbortSignal;
}

const PROVIDER_TIMEOUT_MS = 30_000;

function sanitizeUrl(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        return parsed.toString();
    } catch {
        return "[invalid provider URL]";
    }
}

function classifyStatus(status: number): AiProviderErrorKind {
    if (status === 401 || status === 403) return "AUTHENTICATION";
    if (status === 404) return "NOT_FOUND";
    if (status === 400 || status === 422) return "INVALID_REQUEST";
    if (status === 413) return "UNSUPPORTED";
    if (status === 429) return "RATE_LIMITED";
    if (status === 408 || status >= 500) return "TRANSIENT";
    return "UNKNOWN";
}

/** POST JSON with normalized, credential-safe errors. Callers decide whether to retry. */
export function postJson<T>(url: string, options: RequestJsonOptions & { json: unknown }): Promise<T> {
    return requestJson<T>("post", url, options);
}

/** GET JSON with the same error handling as postJson. */
export function getJson<T>(url: string, options: Omit<RequestJsonOptions, "json"> = {}): Promise<T> {
    return requestJson<T>("get", url, options);
}

async function requestJson<T>(method: "get" | "post", url: string, options: RequestJsonOptions): Promise<T> {
    try {
        const response = ky(url, {
            method,
            headers: options.headers,
            json: options.json,
            timeout: options.timeout ?? PROVIDER_TIMEOUT_MS,
            signal: options.signal,
            // Retries belong to the job system, which honors Retry-After and the provider rate limit.
            retry: 0,
            fetch: guardedFetch as typeof fetch,
        });
        return await response.json<T>();
    } catch (error) {
        if (error instanceof HTTPError) {
            // Ky 2 consumes the response body when it populates HTTPError.data. Only JSON error bodies are
            // passed on: anything else (HTML pages, internal services) must not be echoed back to users.
            const isJson = /json/i.test(error.response.headers.get("content-type") ?? "");
            let body = !isJson ? "" : typeof error.data === "string" ? error.data : (JSON.stringify(error.data) ?? "");
            const providerUrl = new URL(url);
            const headerSecrets = Object.entries(options.headers ?? {})
                .filter(([name]) => /^(authorization|x-goog-api-key|x-api-key|api-key)$/i.test(name))
                .map(([, value]) => value.replace(/^Bearer\s+/i, ""));
            const secrets = [providerUrl.searchParams.get("key"), providerUrl.searchParams.get("api_key"), ...headerSecrets];
            for (const secret of secrets) {
                if (secret) body = body.replaceAll(secret, "[REDACTED]");
            }
            body = getSafeAiErrorMessage(body).slice(0, 500);
            const status = error.response.status;
            const kind = classifyStatus(status);
            const suffix = body ? `: ${body}` : "";
            throw new AiProviderError(
                kind,
                `${status} ${error.response.statusText || "Provider request failed"} from ${sanitizeUrl(url)}${suffix}`,
                status,
                parseRetryAfterHeader(error.response.headers.get("retry-after")),
            );
        }

        if (error instanceof TimeoutError) {
            throw new AiProviderError("TIMEOUT", `Provider request timed out after ${options.timeout ?? PROVIDER_TIMEOUT_MS}ms`);
        }

        if (error instanceof NetworkError) {
            throw new AiProviderError("TRANSIENT", "Provider request failed due to a network error");
        }

        throw error;
    }
}
