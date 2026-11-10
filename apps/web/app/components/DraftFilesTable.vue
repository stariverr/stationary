<script setup lang="ts">
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { DraftFileRole, getDraftFileRole, type DraftFileConfig, type MediaType } from "@/utils/draft-media-rules";

/**
 * The files of one media draft and the role each takes in it: original, cover or caption, decided by its file type.
 * Captions also get a label, a language and at most one default. A table where the container is wide, cards otherwise.
 */
const props = defineProps<{ mediaType: MediaType; files: DraftFileConfig[] }>();

const roleOf = (file: DraftFileConfig) => getDraftFileRole(props.mediaType, file);

const roleLabelKey = (file: DraftFileConfig) => {
    const role = roleOf(file);
    return role ? `media.roles.${role.toLowerCase()}` : "media.roles.not_allowed";
};

const setDefaultCaption = (file: DraftFileConfig, checked: unknown) => {
    const isDefault = checked === true;
    for (const other of props.files) {
        if (isDefault && other !== file && roleOf(other) === DraftFileRole.CAPTION) other.is_default = false;
    }
    file.is_default = isDefault;
};
</script>

<template>
    <div class="@container">
        <!-- Wide containers: table -->
        <div class="hidden overflow-x-auto rounded-lg border bg-gray-50/20 dark:bg-zinc-900/30 text-xs @2xl:block">
            <table class="w-full table-fixed border-collapse text-left">
                <thead>
                    <tr
                        class="bg-slate-50 dark:bg-zinc-900 text-slate-500 dark:text-zinc-400 font-semibold border-b border-slate-100 dark:border-zinc-800 text-xs uppercase tracking-wider"
                    >
                        <th class="w-[34%] p-3">{{ $t("media.headers.file") }}</th>
                        <th class="w-[16%] p-3">{{ $t("media.headers.role") }}</th>
                        <th class="w-[22%] p-3">{{ $t("media.headers.label") }}</th>
                        <th class="w-[16%] p-3">{{ $t("media.headers.language") }}</th>
                        <th class="w-[12%] p-3 text-center">{{ $t("media.headers.default") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="file in files"
                        :key="file.draft_file_id"
                        class="border-b last:border-0 border-slate-100 dark:border-zinc-800 hover:bg-slate-50/40 dark:hover:bg-zinc-800/20"
                    >
                        <td class="p-3 text-slate-700 dark:text-zinc-300" :title="file.name">
                            <div class="truncate font-medium">{{ file.name }}</div>
                            <div class="truncate text-gray-500 dark:text-zinc-500">{{ file.mime_type }}</div>
                        </td>
                        <td class="p-3" :class="roleOf(file) ? '' : 'text-red-600 dark:text-red-400'">{{ $t(roleLabelKey(file)) }}</td>
                        <template v-if="roleOf(file) === DraftFileRole.CAPTION">
                            <td class="p-1.5">
                                <Input
                                    v-model="file.label"
                                    :aria-label="`${$t('media.headers.label')}: ${file.name}`"
                                    class="h-8 text-xs"
                                />
                            </td>
                            <td class="p-1.5">
                                <Input
                                    v-model="file.language"
                                    placeholder="en"
                                    :aria-label="`${$t('media.headers.language')}: ${file.name}`"
                                    class="h-8 text-xs"
                                />
                            </td>
                            <td class="p-3 text-center">
                                <Checkbox
                                    :model-value="file.is_default"
                                    :aria-label="`${$t('media.headers.default')}: ${file.name}`"
                                    @update:model-value="(value: unknown) => setDefaultCaption(file, value)"
                                />
                            </td>
                        </template>
                        <td v-else colspan="3" class="p-3 text-gray-400 dark:text-zinc-500">—</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Narrow containers: one card per file -->
        <div class="space-y-3 @2xl:hidden">
            <div
                v-for="file in files"
                :key="`card-${file.draft_file_id}`"
                class="space-y-3 rounded-lg border dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3.5"
            >
                <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0">
                        <div class="truncate text-sm font-medium">{{ file.name }}</div>
                        <div class="mt-0.5 truncate text-xs text-gray-500 dark:text-zinc-400">{{ file.mime_type }}</div>
                    </div>
                    <span
                        class="shrink-0 text-xs font-semibold"
                        :class="roleOf(file) ? 'text-gray-600 dark:text-zinc-300' : 'text-red-600'"
                    >
                        {{ $t(roleLabelKey(file)) }}
                    </span>
                </div>
                <div v-if="roleOf(file) === DraftFileRole.CAPTION" class="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-center gap-2">
                    <Input
                        v-model="file.label"
                        :placeholder="$t('media.headers.label')"
                        :aria-label="`${$t('media.headers.label')}: ${file.name}`"
                        class="h-9 text-xs"
                    />
                    <Input
                        v-model="file.language"
                        placeholder="en"
                        :aria-label="`${$t('media.headers.language')}: ${file.name}`"
                        class="h-9 text-xs"
                    />
                    <label class="flex items-center gap-1.5 text-xs text-gray-500 dark:text-zinc-400">
                        <Checkbox :model-value="file.is_default" @update:model-value="(value: unknown) => setDefaultCaption(file, value)" />
                        {{ $t("media.headers.default") }}
                    </label>
                </div>
            </div>
        </div>
    </div>
</template>
