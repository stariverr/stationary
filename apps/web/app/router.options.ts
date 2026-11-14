import type { RouterOptions } from "vue-router";

export default <RouterOptions>{
    scrollBehavior(to, from, savedPosition) {
        // Same page (only query parameters changed, or a post opened/closed over the list): keep the scroll
        if (to.path === from.path || (to.name === "posts-id" && from.name === "posts-id")) {
            return savedPosition || false;
        }
        return savedPosition || { top: 0, left: 0 };
    },
};
