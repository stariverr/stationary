<script setup lang="ts">
import { computed } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ name: string; class?: string }>();

/** Providers have no logos; a stable tint per name tells them apart at a glance. */
const TINTS = [
    "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
    "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
    "bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
];

const tint = computed(() => {
    let hash = 0;
    for (const char of props.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    return TINTS[hash % TINTS.length];
});
</script>

<template>
    <span :class="cn('flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold', tint, props.class)">
        {{ name.trim().charAt(0).toUpperCase() || "?" }}
    </span>
</template>
