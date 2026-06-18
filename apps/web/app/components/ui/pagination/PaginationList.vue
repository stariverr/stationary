<script setup lang="ts">
import { type HTMLAttributes, computed } from "vue";
import { PaginationList, type PaginationListProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<PaginationListProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = computed(() => {
    const { class: _, ...delegated } = props;

    return delegated;
});
</script>

<template>
    <PaginationList v-bind="delegatedProps" :class="cn('flex flex-row items-center gap-1', props.class)">
        <slot />
    </PaginationList>
</template>
