<script setup lang="ts">
import PostGrid from "@/components/PostGrid.vue";

// /posts and /posts/:id share one page instance, so opening or closing a post
// does not remount the grid. The post store reads the selected post from the URL.
definePageMeta({ key: "posts" });
</script>

<template>
    <PostGrid />
</template>
