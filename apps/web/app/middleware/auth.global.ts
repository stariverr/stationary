const publicRoutes = ["/login", "/register", "/verify-email", "/forgot-password", "/terms", "/privacy"];
const authOnlyRoutes = ["/login", "/register", "/verify-email", "/forgot-password"];

export default defineNuxtRouteMiddleware(async (to) => {
    const { $auth } = useNuxtApp();

    try {
        const headers = import.meta.server ? (useRequestHeaders(["cookie"]) as HeadersInit) : undefined;
        const { data: session } = await $auth.getSession({
            fetchOptions: {
                headers,
            },
        });
        const isAuthed = !!session?.user;

        if (!isAuthed) {
            if (publicRoutes.includes(to.path)) {
                return;
            }
            return navigateTo("/login");
        }

        if (authOnlyRoutes.includes(to.path)) {
            return navigateTo("/");
        }
    } catch (e) {
        console.error("Middleware Error:", e);
        if (!publicRoutes.includes(to.path)) {
            return navigateTo("/login");
        }
    }
});
