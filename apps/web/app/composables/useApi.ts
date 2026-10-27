import type { AnyServerRouteMethod, TypedFetchOptions } from "#app";

type ApiFetchOptions = TypedFetchOptions<string, AnyServerRouteMethod>;

export const useApi = <T>(request: string, opts?: ApiFetchOptions) => {
    return useNuxtApp().$api<T, string, AnyServerRouteMethod>(request, opts);
};
