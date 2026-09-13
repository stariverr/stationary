type ApiFetchOptions = NonNullable<Parameters<typeof $fetch>[1]>;

/**
 * A wrapper around $fetch that directly communicates with the backend API,
 * bypassing any frontend proxy, forwarding session cookies during SSR,
 * and including credentials for cross-origin requests.
 */
export const useApi = async <T>(request: string, opts?: ApiFetchOptions) => {
    // 关键：在 SSR 环境下手动透传 Cookie
    const headers = import.meta.server ? useRequestHeaders(["cookie"]) : undefined;

    const config = useRuntimeConfig();
    const rawApiBaseUrl = import.meta.server
        ? (config.apiBaseUrl as string) || (config.public.apiBaseUrl as string) || "http://127.0.0.1:9400"
        : (config.public.apiBaseUrl as string) || "";
    const baseUrl = rawApiBaseUrl ? rawApiBaseUrl.replace(/\/$/, "") : "";

    let url: string;
    if (request.startsWith("http://") || request.startsWith("https://")) {
        url = request;
    } else {
        const path = request.startsWith("/api/") ? request : `/api/${request.replace(/^\//, "")}`;
        url = `${baseUrl}${path}`;
    }

    return $fetch<T>(url, {
        credentials: "include",
        ...opts,
        headers: {
            ...headers,
            ...opts?.headers,
        },
    });
};
