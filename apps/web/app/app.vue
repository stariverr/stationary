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
    // 1. 禁止双指/鼠标 wheel 放大 (Ctrl/Cmd + Wheel)
    const handleWheel = (e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
        }
    };

    // 2. 禁止手势放大 (gesturestart) - 主要针对 iOS Safari
    const handleGestureStart = (e: Event) => {
        e.preventDefault();
    };

    // 3. 禁止双指 touchstart/touchmove 放大
    const handleTouchStart = (e: TouchEvent) => {
        if (e.touches.length > 1) {
            e.preventDefault();
        }
    };

    // 添加事件监听器，使用 { passive: false } 允许 preventDefault
    document.addEventListener("wheel", handleWheel, { passive: false });
    document.addEventListener("gesturestart", handleGestureStart, { passive: false });
    document.addEventListener("touchstart", handleTouchStart, { passive: false });

    // 组件卸载时清理事件监听器
    onBeforeUnmount(() => {
        document.removeEventListener("wheel", handleWheel);
        document.removeEventListener("gesturestart", handleGestureStart);
        document.removeEventListener("touchstart", handleTouchStart);
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
