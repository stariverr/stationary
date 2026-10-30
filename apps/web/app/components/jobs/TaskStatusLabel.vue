<script setup lang="ts">
// Status of a task or one of its units: a colored dot plus the translated name, so color never carries the meaning alone.
const props = defineProps<{ status: string }>();

const DOT: Record<string, string> = {
    RUNNING: "bg-blue-500 animate-pulse motion-reduce:animate-none",
    DISCOVERING: "bg-blue-500 animate-pulse motion-reduce:animate-none",
    PAUSED: "bg-amber-500",
    FAILED: "bg-red-500",
    COMPLETED: "bg-emerald-500",
    SUCCEEDED: "bg-emerald-500",
};

const { t } = useI18n();

const label = computed(() => {
    const key = `jobs.tabs.${props.status.toLowerCase()}`;
    const translated = t(key);
    return translated !== key ? translated : props.status;
});
</script>

<template>
    <span class="inline-flex items-center gap-1.5 whitespace-nowrap" :class="status === 'FAILED' ? 'text-red-600' : 'text-zinc-600'">
        <span class="size-1.5 shrink-0 rounded-full" :class="DOT[status] ?? 'bg-zinc-300'" aria-hidden="true" />
        {{ label }}
    </span>
</template>
