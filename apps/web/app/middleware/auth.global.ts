import { useSession } from "@/lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
    try {
        // 使用 useSession(useFetch) 是官方推荐的 Nuxt SSR 方式，
        // 能确保在服务端渲染时请求带着正确的 cookie 且不丢失 Nuxt 上下文。
        const { data: session } = await useSession(useFetch);
        const publicRoutes = ["/login", "/register", "/verify-email", "/forgot-password", "/terms", "/privacy"];

        if (!session.value) {
            if (publicRoutes.includes(to.path)) {
                return;
            }
            return navigateTo("/login");
        }

        const authOnlyRoutes = ["/login", "/register", "/verify-email", "/forgot-password"];
        if (authOnlyRoutes.includes(to.path) && session.value) {
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
