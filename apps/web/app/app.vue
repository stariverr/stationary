<script setup lang="ts">
import { onMounted, onBeforeUnmount } from "vue";
import { Toaster } from "@/components/ui/sonner";

useHead({
    meta: [
        {
            name: "viewport",
            content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover",
        },
    ],
});

onMounted(() => {
    // 1. Prevent pinch/wheel zoom (Ctrl/Cmd + Wheel)
    const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
        }
    };

    // 2. Prevent gesture zoom (gesturestart) - primarily for iOS Safari
    const handleGestureStart = (e: Event) => {
        e.preventDefault();
    };

    // 3. Prevent multi-touch pinch zoom
    const handleTouchStart = (e: TouchEvent) => {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    };

    // 4. Prevent double-tap to zoom (touchend)
    let lastTouchEnd = 0;
    const handleTouchEnd = (e: TouchEvent) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 300) {
            const target = e.target as HTMLElement | null;
            if (target) {
                const tagName = target.tagName.toLowerCase();
                // Exclude inputs, textareas, selects, and contenteditable elements to keep focus and text selection working normally
                if (["input", "textarea", "select"].includes(tagName) || target.isContentEditable) {
                    return;
                }
                // Prevent default double-tap to zoom behavior
                e.preventDefault();
                // Programmatically dispatch click event to keep fast/double clicking functional on buttons/links
                target.click();
            }
        }
        lastTouchEnd = now;
    };

    // Add event listeners with { passive: false } to allow preventDefault
    document.addEventListener("wheel", handleWheel, { passive: false });
    document.addEventListener("gesturestart", handleGestureStart, { passive: false });
    document.addEventListener("touchstart", handleTouchStart, { passive: false });
    document.addEventListener("touchend", handleTouchEnd, { passive: false });

    // Clean up event listeners when component is unmounted
    onBeforeUnmount(() => {
        document.removeEventListener("wheel", handleWheel);
        document.removeEventListener("gesturestart", handleGestureStart);
        document.removeEventListener("touchstart", handleTouchStart);
        document.removeEventListener("touchend", handleTouchEnd);
    });
});
</script>

<template>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
        <NuxtPage />
    </NuxtLayout>
    <ClientOnly>
        <Toaster rich-colors position="top-right" />
    </ClientOnly>
</template>
