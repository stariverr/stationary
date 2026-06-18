import type { FetchOptions } from "ofetch";

/**
 * A wrapper around $fetch that automatically prepends the API base URL
 * and forwards the session cookies during SSR.
 */
export const useApi = async <T>(request: string, opts?: FetchOptions | any) => {
    // 关键：在 SSR 环境下手动透传 Cookie
    const headers = useRequestHeaders(["cookie"]) as HeadersInit;

    // Ensure the request path starts with /api/
    const path = request.startsWith("/api/") ? request : `/api/${request.replace(/^\//, "")}`;

    return $fetch<T>(path, {
        ...opts,
        headers: {
            ...headers,
            ...opts?.headers,
        },
    });
};
