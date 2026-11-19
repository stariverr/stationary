<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Loader2 } from "@lucide/vue";
import { toast } from "vue-sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SourceErrorNote from "@/components/SourceErrorNote.vue";
import { apiErrorMessage, useApi } from "@/composables/useApi";
import type { ApiResponse } from "@/types/api";
import { MediaType, type MediaDetail, type MediaOriginal } from "@/types/post";
import { canHaveCaptions, takesOriginalKind } from "@/utils/draft-media-rules";
import { canHaveCover } from "@/utils/media";

/**
 * Changes the type of a media and deletes the originals the new type does not take, in one step
 * (docs/failure_handling.zh-Hans.md, 9.1): a LIVE_PHOTO whose video turned out to be broken becomes an IMAGE without
 * it. The originals that do not fit the new type, or are not what the import declared, start ticked; the server checks
 * what is left and its message shows here when it refuses.
 */
const props = defineProps<{
    open: boolean;
    media: MediaDetail;
    /** Originals to tick besides the ones the new type does not take. */
    preselectedOriginalIds?: readonly string[];
}>();

const emit = defineEmits<{
    (e: "update:open", value: boolean): void;
    (e: "changed"): void;
}>();

const { t } = useI18n();

const newType = ref<MediaType>(props.media.type);
const deleteIds = ref<string[]>([]);
const error = ref<string | null>(null);
const isSaving = ref(false);

const defaultDeleteIds = (type: MediaType) =>
    props.media.originals
        .filter(
            (original) =>
                original.error_kind === "KIND_MISMATCH" ||
                !takesOriginalKind(type, original.kind) ||
                props.preselectedOriginalIds?.includes(original.id),
        )
        .map((original) => original.id);

watch(
    () => props.open,
    (open) => {
        if (!open) return;
        newType.value = props.media.type;
        deleteIds.value = defaultDeleteIds(props.media.type);
        error.value = null;
    },
    { immediate: true },
);

const changeNewType = (type: unknown) => {
    newType.value = type as MediaType;
    deleteIds.value = defaultDeleteIds(newType.value);
    error.value = null;
};

const toggle = (id: string, checked: boolean | "indeterminate") => {
    deleteIds.value = checked === true ? [...deleteIds.value, id] : deleteIds.value.filter((item) => item !== id);
};

const dropsCaptions = computed(() => props.media.captions.length > 0 && !canHaveCaptions(newType.value));
const dropsCover = computed(() => Boolean(props.media.cover) && !canHaveCover(newType.value));
const hasChange = computed(() => newType.value !== props.media.type || deleteIds.value.length > 0);

const kindLabel = (original: MediaOriginal) =>
    original.kind ? t(`media.editor.kinds.${original.kind.toLowerCase()}`) : t("media.editor.kinds.unknown");

const submit = async () => {
    if (isSaving.value || !hasChange.value) return;
    isSaving.value = true;
    error.value = null;
    try {
        await useApi<ApiResponse<{ id: string }>>(`/media/${props.media.id}/type`, {
            method: "POST",
            body: { type: newType.value, delete_original_ids: deleteIds.value },
        });
        toast.success(t("media.editor.type_changed"));
        emit("changed");
        emit("update:open", false);
    } catch (cause) {
        error.value = apiErrorMessage(cause);
    } finally {
        isSaving.value = false;
    }
};
</script>

<template>
    <Dialog :open="open" @update:open="!isSaving && emit('update:open', $event)">
        <DialogContent class="sm:max-w-md">
            <DialogHeader>
                <DialogTitle>{{ $t("media.editor.change_type") }}</DialogTitle>
                <DialogDescription>{{ $t("media.editor.change_type_desc") }}</DialogDescription>
            </DialogHeader>

            <form class="grid gap-4 py-2" @submit.prevent="submit">
                <div class="grid gap-1.5">
                    <Label for="change-type-select">{{ $t("media.editor.new_type") }}</Label>
                    <Select :model-value="newType" :disabled="isSaving" @update:model-value="changeNewType">
                        <SelectTrigger id="change-type-select">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem v-for="type in Object.values(MediaType)" :key="type" :value="type">
                                {{ $t("media.types." + type) }}
                            </SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                <fieldset class="grid gap-1.5">
                    <legend class="mb-1.5 text-sm font-medium">{{ $t("media.editor.delete_originals") }}</legend>
                    <label
                        v-for="original in media.originals"
                        :key="original.id"
                        class="flex items-start gap-2.5 rounded-lg border border-zinc-200 dark:border-zinc-800 p-2.5 cursor-pointer"
                    >
                        <Checkbox
                            class="mt-0.5"
                            :model-value="deleteIds.includes(original.id)"
                            :disabled="isSaving"
                            @update:model-value="toggle(original.id, $event)"
                        />
                        <span class="min-w-0 flex-1">
                            <span class="block text-xs font-semibold">
                                {{ kindLabel(original) }}
                                <span v-if="original.mime_type" class="font-normal text-zinc-500"> · {{ original.mime_type }}</span>
                            </span>
                            <SourceErrorNote :status="original.status" :kind="original.error_kind" :declared-kind="original.kind" compact />
                        </span>
                    </label>
                </fieldset>

                <p v-if="dropsCaptions" class="text-xs text-amber-600 dark:text-amber-400">{{ $t("media.editor.drops_captions") }}</p>
                <p v-if="dropsCover" class="text-xs text-amber-600 dark:text-amber-400">{{ $t("media.editor.drops_cover") }}</p>
                <p v-if="error" role="alert" class="text-xs text-red-500 break-words">{{ error }}</p>

                <DialogFooter>
                    <Button type="button" variant="outline" :disabled="isSaving" @click="emit('update:open', false)">
                        {{ $t("media.editor.cancel") }}
                    </Button>
                    <Button type="submit" :disabled="isSaving || !hasChange">
                        <Loader2 v-if="isSaving" class="w-4 h-4 animate-spin" />
                        {{ $t("media.editor.confirm") }}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
</template>
