<script setup lang="ts">
import { Toaster } from "@/components/ui/sonner";
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
