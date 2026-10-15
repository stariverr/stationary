<script setup lang="ts">
import type { AcceptableValue } from "reka-ui";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";

const { locale, setLocale, locales } = useI18n();

const localeOptions = computed(() =>
    locales.value.map((l) => (typeof l === "string" ? { code: l, name: l } : { code: l.code, name: l.name ?? l.code })),
);

const handleLocaleChange = (value: AcceptableValue) => {
    if (typeof value === "string") setLocale(value as typeof locale.value);
};
</script>

<template>
    <Card class="py-0">
        <CardContent class="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div class="grid gap-1">
                <Label for="settings-language">{{ $t("settings.general.language") }}</Label>
                <p class="text-sm text-muted-foreground">{{ $t("settings.general.language_desc") }}</p>
            </div>
            <Select :model-value="locale" @update:model-value="handleLocaleChange">
                <SelectTrigger id="settings-language" class="w-full sm:w-48">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        <SelectItem v-for="l in localeOptions" :key="l.code" :value="l.code">
                            {{ l.name }}
                        </SelectItem>
                    </SelectGroup>
                </SelectContent>
            </Select>
        </CardContent>
    </Card>
</template>
