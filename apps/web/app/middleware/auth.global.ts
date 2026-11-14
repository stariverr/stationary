const publicRoutes = ["/login", "/register", "/verify-email", "/forgot-password", "/terms", "/privacy"];
const authOnlyRoutes = ["/login", "/register", "/verify-email", "/forgot-password"];

// Remember the page the user asked for, so signing in lands back on it.
const loginRoute = (fullPath: string) => (fullPath === "/" ? "/login" : { path: "/login", query: { redirect: fullPath } });

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
            return navigateTo(loginRoute(to.fullPath));
        }

        if (authOnlyRoutes.includes(to.path)) {
            return navigateTo(authRedirectTarget(to.query.redirect));
        }
    } catch (e) {
        console.error("Middleware Error:", e);
        if (!publicRoutes.includes(to.path)) {
            return navigateTo(loginRoute(to.fullPath));
        }
    }
});
