<script setup lang="ts">
import { Sun, Moon, Monitor } from "@lucide/vue";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";

const colorMode = useThemeMode();

const themeOptions = [
    { value: "light", label: "settings.appearance.theme_light", icon: Sun },
    { value: "dark", label: "settings.appearance.theme_dark", icon: Moon },
    { value: "auto", label: "settings.appearance.theme_system", icon: Monitor },
] as const;

const selectedTheme = computed(() => colorMode.store.value);

// `store` holds the choice, including "auto"; the ref itself resolves "auto" to light or dark.
const setColorMode = (value: unknown) => {
    const theme = themeOptions.find((option) => option.value === value);
    if (theme) colorMode.store.value = theme.value;
};
</script>

<template>
    <Card class="py-0">
        <CardContent class="grid gap-4 p-5">
            <div class="grid gap-1">
                <Label>{{ $t("settings.appearance.theme") }}</Label>
                <p class="text-sm text-muted-foreground">{{ $t("settings.appearance.theme_desc") }}</p>
            </div>
            <ToggleGroup
                type="single"
                variant="outline"
                :spacing="3"
                class="grid w-full max-w-md grid-cols-3"
                :model-value="selectedTheme"
                @update:model-value="setColorMode"
            >
                <ToggleGroupItem v-for="theme in themeOptions" :key="theme.value" :value="theme.value" class="h-auto flex-col gap-2 py-4">
                    <component :is="theme.icon" class="size-5" />
                    <span class="text-xs">{{ $t(theme.label) }}</span>
                </ToggleGroupItem>
            </ToggleGroup>
        </CardContent>
    </Card>
</template>
