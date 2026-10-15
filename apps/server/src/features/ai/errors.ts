export type QueueAiErrorKind = "FORBIDDEN" | "INVALID_PARAMETER";

export class QueueAiError extends Error {
    constructor(
        public readonly kind: QueueAiErrorKind,
        message: string,
    ) {
        super(message);
        this.name = "QueueAiError";
    }
}

export type AiProviderErrorKind =
    | "AUTHENTICATION"
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "TRANSIENT"
    | "TIMEOUT"
    | "UNSUPPORTED"
    | "UNKNOWN";

export class AiProviderError extends Error {
    constructor(
        public readonly kind: AiProviderErrorKind,
        message: string,
        public readonly status?: number,
        public readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = "AiProviderError";
    }
}

/**
 * Raised before calling a provider when its rate limit has no capacity. No request was sent,
 * so callers may retry after `retryAfterMs` without counting it as a failed attempt.
 */
export class AiThrottledError extends Error {
    constructor(
        public readonly providerId: string,
        public readonly retryAfterMs: number,
    ) {
        super(`Provider ${providerId} is at its rate limit; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        this.name = "AiThrottledError";
    }
}

export class AiConfigurationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AiConfigurationError";
    }
}

export interface AiErrorClassification {
    kind: AiProviderErrorKind | "CONFIGURATION" | "CANCELLED" | "THROTTLED";
    retryable: boolean;
    /** Provider-requested (Retry-After) or limiter-computed delay before the next attempt. */
    retryAfterMs?: number;
}

/** Parses a Retry-After header value (seconds or HTTP date) into milliseconds. */
export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - now);
}

/** Reads Retry-After from AI SDK call errors, which expose the raw response headers. */
function getSdkRetryAfterMs(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const headers = (error as { responseHeaders?: unknown }).responseHeaders;
    if (!headers || typeof headers !== "object") return undefined;
    const entry = Object.entries(headers as Record<string, unknown>).find(([name]) => name.toLowerCase() === "retry-after");
    return typeof entry?.[1] === "string" ? parseRetryAfterHeader(entry[1]) : undefined;
}

function getNumericStatus(error: unknown): number | undefined {
    if (!error || typeof error !== "object") return undefined;
    const candidate = error as { status?: unknown; statusCode?: unknown };
    const status = candidate.statusCode ?? candidate.status;
    return typeof status === "number" ? status : undefined;
}

/** Name, message and system error code (e.g. ECONNREFUSED) of the error and its causes. */
function getErrorText(error: unknown): string {
    const parts: string[] = [];
    for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
        if (!(current instanceof Error)) {
            parts.push(String(current));
            break;
        }
        const code = (current as { code?: unknown }).code;
        parts.push(current.name, current.message, typeof code === "string" ? code : "");
        current = current.cause;
    }
    return parts.join(" ").toLowerCase();
}

export function getSafeAiErrorMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message
        .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
        .replace(/(["']?(?:api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["']?)[^"',\s}]+/gi, "$1[REDACTED]")
        .slice(0, 1000);
}

/**
 * Provider SDKs do not expose one shared error type. Keep the retry policy in one
 * place and use status/message signals from the SDKs that do not go through http.ts.
 */
export function classifyAiError(error: unknown): AiErrorClassification {
    if (error instanceof AiConfigurationError) {
        return { kind: "CONFIGURATION", retryable: false };
    }

    if (error instanceof AiThrottledError) {
        return { kind: "THROTTLED", retryable: true, retryAfterMs: error.retryAfterMs };
    }

    if (error instanceof AiProviderError) {
        return {
            kind: error.kind,
            retryable: error.kind === "RATE_LIMITED" || error.kind === "TRANSIENT" || error.kind === "TIMEOUT",
            retryAfterMs: error.retryAfterMs,
        };
    }

    const text = getErrorText(error);
    if (text.includes("abort") || text.includes("cancel")) {
        return { kind: "CANCELLED", retryable: false };
    }

    const status = getNumericStatus(error);
    if (status === 401 || status === 403) return { kind: "AUTHENTICATION", retryable: false };
    if (status === 404) return { kind: "NOT_FOUND", retryable: false };
    if (status === 400 || status === 422) return { kind: "INVALID_REQUEST", retryable: false };
    if (status === 408 || status === 429 || (status !== undefined && status >= 500)) {
        return {
            kind: status === 429 ? "RATE_LIMITED" : "TRANSIENT",
            retryable: true,
            retryAfterMs: getSdkRetryAfterMs(error),
        };
    }

    if (error && typeof error === "object" && (error as { isRetryable?: unknown }).isRetryable === true) {
        return { kind: "TRANSIENT", retryable: true };
    }

    if (
        text.includes("timeout") ||
        text.includes("timed out") ||
        text.includes("econnreset") ||
        text.includes("econnrefused") ||
        text.includes("ehostunreach") ||
        text.includes("enetunreach") ||
        text.includes("eai_again") ||
        text.includes("etimedout") ||
        text.includes("fetch failed") ||
        text.includes("network") ||
        text.includes("temporarily unavailable") ||
        text.includes("service unavailable") ||
        text.includes("rate limit") ||
        text.includes("too many requests") ||
        text.includes("overloaded")
    ) {
        return { kind: text.includes("timeout") || text.includes("timed out") ? "TIMEOUT" : "TRANSIENT", retryable: true };
    }

    return { kind: "UNKNOWN", retryable: false };
}
