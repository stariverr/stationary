<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useImportStore, type DraftFileItem } from "@/stores/import";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "vue-sonner";
import {
    buildMediaDraft,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    guessMediaType,
    toDraftFileConfig,
    MediaType,
    type DraftFileConfig,
} from "@/utils/draft-media-rules";
import DraftFilesTable from "@/components/DraftFilesTable.vue";
import { apiErrorMessage } from "@/composables/useApi";
import { Info, AlertCircle } from "@lucide/vue";

const props = defineProps<{
    open: boolean;
    selectedDraftFiles: DraftFileItem[];
    libraryId: string;
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
    (e: "merged", title: string): void;
}>();

const importStore = useImportStore();
const queryClient = useQueryClient();
const { t } = useI18n();

const mergeTitle = ref("");
const mergeType = ref<MediaType>(MediaType.IMAGE);

const mergeFiles = ref<DraftFileConfig[]>([]);

const compatibleMergeTypes = computed(() => getCompatibleMediaTypes(mergeFiles.value));
const mergeCompositionError = computed(() => {
    const err = getDraftCompositionError(mergeType.value, mergeFiles.value);
    if (!err) return null;
    return err.params ? t(err.key, err.params) : t(err.key);
});

function handleMergeTypeChange(value: unknown) {
    if (typeof value !== "string" || !compatibleMergeTypes.value.includes(value as MediaType)) return;
    mergeType.value = value as MediaType;
}

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen && props.selectedDraftFiles.length > 0) {
            const firstFile = props.selectedDraftFiles[0];
            if (firstFile) {
                mergeTitle.value = firstFile.name.substring(0, firstFile.name.lastIndexOf(".")) || firstFile.name;
            }
            mergeFiles.value = props.selectedDraftFiles.map(toDraftFileConfig);
            mergeType.value = guessMediaType(mergeFiles.value) ?? MediaType.IMAGE;
        }
    },
    { immediate: true },
);

async function handleCommitMerge() {
    if (!mergeTitle.value.trim() || !props.libraryId) return;

    const compositionError = mergeCompositionError.value;
    if (compositionError) {
        toast.warning(t("media.toast_invalid_composition"), {
            description: compositionError,
        });
        return;
    }

    const payload = { media_drafts: [buildMediaDraft(mergeTitle.value.trim(), mergeType.value, mergeFiles.value)] };

    try {
        await importStore.commitMedia(props.libraryId, payload);
        emit("update:open", false);
        emit("merged", mergeTitle.value.trim());
        toast.success(t("draft_box.toasts.merge_success"), {
            description: t("draft_box.toasts.merge_success_desc", { title: mergeTitle.value.trim() }),
        });
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: unknown) {
        toast.error(t("draft_box.toasts.merge_failed"), {
            description: apiErrorMessage(e),
        });
    }
}
</script>

<template>
    <Dialog :open="open" @update:open="emit('update:open', $event)">
        <DialogContent
            class="flex w-[calc(100%-1rem)] max-w-none max-h-[calc(100dvh-1rem)] flex-col gap-0 overflow-hidden p-0 sm:w-[calc(100%-2rem)] sm:max-w-5xl sm:max-h-[88dvh]"
        >
            <DialogHeader class="shrink-0 border-b px-4 pt-5 pr-12 pb-4 text-left sm:px-6 sm:pt-6 sm:pr-12">
                <DialogTitle>{{ $t("draft_box.merge_dialog_title") }}</DialogTitle>
                <DialogDescription>
                    {{ $t("draft_box.merge_dialog_desc") }}
                </DialogDescription>
            </DialogHeader>

            <!-- Form Content -->
            <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
                <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_16rem]">
                    <div class="space-y-1.5">
                        <Label for="merge-title">{{ $t("draft_box.merge_dialog.title_label") }}</Label>
                        <Input id="merge-title" v-model="mergeTitle" :placeholder="$t('draft_box.merge_dialog.title_placeholder')" />
                    </div>
                    <div class="space-y-1.5">
                        <Label for="merge-type">{{ $t("draft_box.merge_dialog.type_label") }}</Label>
                        <Select
                            :model-value="mergeType"
                            :disabled="compatibleMergeTypes.length <= 1"
                            @update:model-value="handleMergeTypeChange"
                        >
                            <SelectTrigger id="merge-type">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem v-for="type in compatibleMergeTypes" :key="type" :value="type">
                                    {{ $t("media.types." + type) }}
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>

                <!-- What each file becomes -->
                <div class="space-y-2">
                    <div class="text-xs font-semibold text-gray-500 flex items-center gap-1">
                        <Info class="w-3.5 h-3.5" /> {{ $t("media.configure_files") }}
                    </div>

                    <DraftFilesTable :media-type="mergeType" :files="mergeFiles" />

                    <div
                        v-if="mergeCompositionError"
                        class="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700"
                        role="alert"
                    >
                        <AlertCircle class="mt-0.5 size-4 shrink-0" />
                        <span>{{ mergeCompositionError }}</span>
                    </div>
                </div>
            </div>

            <!-- Footer Actions -->
            <DialogFooter class="shrink-0 border-t px-4 py-4 sm:px-6">
                <Button variant="outline" class="w-full sm:w-auto" @click="emit('update:open', false)">{{
                    $t("media.actions.cancel")
                }}</Button>
                <Button
                    class="w-full sm:w-auto"
                    :disabled="!mergeTitle.trim() || Boolean(mergeCompositionError)"
                    @click="handleCommitMerge"
                >
                    {{ $t("draft_box.merge_dialog.commit_btn") }}
                </Button>
            </DialogFooter>
        </DialogContent>
    </Dialog>
</template>
