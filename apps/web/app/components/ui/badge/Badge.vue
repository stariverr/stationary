<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow]",
    {
        variants: {
            variant: {
                default: "border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
                secondary: "border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90",
                destructive:
                    "border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40",
                outline: "text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground",
                success: "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                warning: "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                info: "border-blue-500/20 bg-blue-500/10 text-blue-700 dark:text-blue-400",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    },
);

export type BadgeVariants = VariantProps<typeof badgeVariants>;

const props = defineProps<{
    variant?: BadgeVariants["variant"];
    class?: HTMLAttributes["class"];
}>();
</script>

<template>
    <div :class="cn(badgeVariants({ variant }), props.class)">
        <slot />
    </div>
</template>
