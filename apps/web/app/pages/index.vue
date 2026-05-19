<script setup lang="ts">
import { useMediaStore } from '@/stores/media';
const { medias, displayMode } = useMediaStore();
</script>

<template>
    <MediaGrid />
    <MediaLightbox />
</template>
