import { createAuthClient } from "better-auth/vue";
import { emailOTPClient } from "better-auth/client/plugins";

const configuredUrl =
    (typeof window !== "undefined" && (window as any)?.__NUXT__?.config?.public?.apiBaseUrl) || process.env.NUXT_PUBLIC_API_BASE_URL;

const rawApiBaseUrl = configuredUrl || (typeof window !== "undefined" ? window.location.origin : "http://localhost:9400");
const apiBaseUrl = rawApiBaseUrl.replace(/\/+$/, "");

export const authClient = createAuthClient({
    baseURL: apiBaseUrl,
    plugins: [emailOTPClient()],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
