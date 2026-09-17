type ApiFetchOptions = NonNullable<Parameters<typeof $fetch>[1]>;

export const useApi = <T>(request: string, opts?: ApiFetchOptions) => {
    return useNuxtApp().$api<T>(request, opts);
};
