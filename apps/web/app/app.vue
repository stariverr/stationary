<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";

useHead({
    meta: [
        {
            name: "viewport",
            content: "width=device-width, initial-scale=1.0, viewport-fit=cover",
        },
    ],
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
