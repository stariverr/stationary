<script setup lang="ts">
import { usePosts } from "@/composables/usePosts";
import PostGrid from "@/components/PostGrid.vue";

const route = useRoute();
const { selectPost } = usePosts();

// Sync route ID with global selection state so PostDetail full-screen overlay opens
watch(
    () => route.params.id,
    (newId) => {
        if (newId) {
            selectPost(newId as string);
        }
    },
    { immediate: true },
);
</script>

<template>
    <PostGrid />
</template>
