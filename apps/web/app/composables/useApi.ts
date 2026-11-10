import type { AnyServerRouteMethod, TypedFetchOptions } from "#app";

type ApiFetchOptions = TypedFetchOptions<string, AnyServerRouteMethod>;

export const useApi = <T>(request: string, opts?: ApiFetchOptions) => {
    return useNuxtApp().$api<T, string, AnyServerRouteMethod>(request, opts);
};

/** The message the API sent with a failed request (e.g. why a draft does not fit its media type), else the error's own. */
export const apiErrorMessage = (error: unknown): string => {
    const message = (error as { data?: { message?: unknown } } | null)?.data?.message;
    if (typeof message === "string" && message) return message;
    return error instanceof Error ? error.message : String(error);
};
