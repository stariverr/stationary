let handlingUnauthorized = false;

export default defineNuxtPlugin((nuxtApp) => {
    const config = useRuntimeConfig();
    const apiBaseUrl = import.meta.server ? (config.apiBaseUrl as string) : (config.public.apiBaseUrl as string);

    const api = $fetch.create({
        baseURL: apiBaseUrl.replace(/\/+$/, ""),
        credentials: "include",
        onRequest({ options }) {
            if (!import.meta.server) return;
            const cookie = useRequestHeaders(["cookie"]).cookie;
            if (cookie) {
                options.headers.set("cookie", cookie);
            }
        },
        async onResponseError({ response }) {
            if (response.status !== 401 || import.meta.server || handlingUnauthorized) return;

            handlingUnauthorized = true;
            try {
                await nuxtApp.$auth.signOut().catch(() => {});
                await nuxtApp.runWithContext(() => navigateTo("/login"));
            } finally {
                handlingUnauthorized = false;
            }
        },
    });

    return {
        provide: {
            api,
        },
    };
});
