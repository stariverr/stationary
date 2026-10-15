/** Remembers where the user came from, so "Back" in settings returns there instead of to the home page. */
export default defineNuxtRouteMiddleware((to, from) => {
    if (to.path.startsWith("/settings") && from.matched.length > 0 && !from.path.startsWith("/settings")) {
        useState("settings-return-to").value = from.fullPath;
    }
});
