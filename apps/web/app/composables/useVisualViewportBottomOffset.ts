import { computed, onMounted, onUnmounted, ref } from "vue";

export const useVisualViewportBottomOffset = () => {
    const offset = ref(0);
    let frameId: number | null = null;

    const updateOffset = () => {
        if (typeof window === "undefined" || typeof document === "undefined") return;

        const visualViewport = window.visualViewport;
        if (!visualViewport) {
            offset.value = 0;
            return;
        }

        // CSS safe-area insets do not track iOS Safari's dynamic toolbar or keyboard.
        // Expose the hidden visual viewport gap so fixed controls can stay visible.
        const layoutHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);
        const viewportBottom = visualViewport.offsetTop + visualViewport.height;
        offset.value = Math.max(0, Math.round(layoutHeight - viewportBottom));
    };

    const scheduleUpdate = () => {
        if (typeof window === "undefined" || frameId !== null) return;

        frameId = window.requestAnimationFrame(() => {
            frameId = null;
            updateOffset();
        });
    };

    onMounted(() => {
        updateOffset();
        window.visualViewport?.addEventListener("resize", scheduleUpdate);
        window.visualViewport?.addEventListener("scroll", scheduleUpdate);
        window.addEventListener("resize", scheduleUpdate);
        window.addEventListener("orientationchange", scheduleUpdate);
    });

    onUnmounted(() => {
        window.visualViewport?.removeEventListener("resize", scheduleUpdate);
        window.visualViewport?.removeEventListener("scroll", scheduleUpdate);
        window.removeEventListener("resize", scheduleUpdate);
        window.removeEventListener("orientationchange", scheduleUpdate);

        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
            frameId = null;
        }
    });

    return computed(() => ({
        "--visual-viewport-bottom-offset": `${offset.value}px`,
    }));
};
