import { createAuthClient } from "better-auth/vue";
import { emailOTPClient } from "better-auth/client/plugins";

const createClient = (baseURL: string) =>
    createAuthClient({
        baseURL,
        plugins: [emailOTPClient()],
    });

export default defineNuxtPlugin(() => {
    const config = useRuntimeConfig();
    const apiBaseUrl = import.meta.server
        ? (config.apiBaseUrl as string).replace(/\/+$/, "")
        : (config.public.apiBaseUrl as string).replace(/\/+$/, "");

    const baseURL = import.meta.server
        ? `${apiBaseUrl}/auth`
        : new URL(`${apiBaseUrl}/auth`, window.location.origin).href;

    return {
        provide: {
            auth: createClient(baseURL),
        },
    };
});
