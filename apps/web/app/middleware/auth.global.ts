import { useSession, authClient } from "@/lib/auth-client";

export default defineNuxtRouteMiddleware(async (to) => {
    try {
        let isAuthed = false;
        if (import.meta.server) {
            // 使用 useSession(useFetch) 是官方推荐的 Nuxt SSR 方式，
            // 能确保在服务端渲染时请求带着正确的 cookie 且不丢失 Nuxt 上下文。
            const { data: session } = await useSession(useFetch);
            isAuthed = !!session.value;
        } else {
            // 在客户端，直接通过 getSession 绕过 Nuxt 的 useFetch 缓存，获取最新的会话状态
            const { data: session } = await authClient.getSession();
            isAuthed = !!session;
        }

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
