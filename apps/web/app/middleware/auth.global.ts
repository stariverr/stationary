import { authClient } from "@/lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
    try {
        const headers = import.meta.server ? (useRequestHeaders(["cookie"]) as HeadersInit) : undefined;
        const { data: session } = await authClient.getSession({
            fetchOptions: {
                headers,
            },
        });
        const isAuthed = !!session;

        const publicRoutes = ["/login", "/register", "/verify-email", "/forgot-password", "/terms", "/privacy"];

        if (!isAuthed) {
            if (publicRoutes.includes(to.path)) {
                return;
            }
            return navigateTo("/login");
        }

        const authOnlyRoutes = ["/login", "/register", "/verify-email", "/forgot-password"];
        if (authOnlyRoutes.includes(to.path) && isAuthed) {
            return navigateTo("/");
        }
    } catch (e) {
        console.error("Middleware Error:", e);
        const publicRoutes = ["/login", "/register", "/verify-email", "/forgot-password", "/terms", "/privacy"];
        if (!publicRoutes.includes(to.path)) {
            return navigateTo("/login");
        }
    }
});
