import type { RouterOptions } from "vue-router";

export default <RouterOptions>{
    scrollBehavior(to, from, savedPosition) {
        // If the path didn't change (e.g. only query parameters like page, keyword changed), do not scroll
        if (to.path === from.path) {
            return savedPosition || false;
        }
        return savedPosition || { top: 0, left: 0 };
    },
};
