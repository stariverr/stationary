<script setup lang="ts">
import { type HTMLAttributes, computed } from "vue";
import { PaginationListItem, type PaginationListItemProps } from "reka-ui";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const props = defineProps<PaginationListItemProps & { class?: HTMLAttributes["class"]; page?: number }>();

const delegatedProps = computed(() => {
    const { class: _, ...delegated } = props;

    return delegated;
});
</script>

<template>
    <PaginationListItem v-bind="delegatedProps" as-child>
        <slot>
            <Button :class="cn('w-9 h-9 p-0', props.class)" :variant="props.value === props.page ? 'default' : 'outline'">
                {{ props.value }}
            </Button>
        </slot>
    </PaginationListItem>
</template>
