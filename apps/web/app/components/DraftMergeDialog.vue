<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useQueryClient } from "@tanstack/vue-query";
import { useImportStore, type DraftFileItem } from "@/stores/import";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "vue-sonner";
import {
    getAllowedFileTrackTypes,
    getAllowedTrackPurposes,
    getCompatibleMediaTypes,
    getDraftCompositionError,
    getRequiredContentTrackTypes,
    isLanguageTrackType,
    normalizeDraftTracksForMedia,
    MediaType,
    TrackPurpose,
    TrackType,
} from "@/utils/draft-media-rules";
import { Info, AlertCircle } from "@lucide/vue";
import { TrackQuality } from "@/types/post";

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

export type MergeTrackConfig = {
    draft_file_id: string;
    name: string;
    mime_type: string;
    type: TrackType | null;
    purpose: TrackPurpose;
    quality: TrackQuality;
    is_default: boolean;
    language: string;
};

const mergeTracksConfig = ref<MergeTrackConfig[]>([]);

const compatibleMergeTypes = computed(() => getCompatibleMediaTypes(mergeTracksConfig.value));
const mergeCompositionError = computed(() => {
    const err = getDraftCompositionError(mergeType.value, mergeTracksConfig.value);
    if (!err) return null;
    return err.params ? t(err.key, err.params) : t(err.key);
});

function getTrackTypeOptions(track: MergeTrackConfig): TrackType[] {
    return getAllowedFileTrackTypes(track.name, track.mime_type).filter(
        (trackType) => getAllowedTrackPurposes(mergeType.value, trackType).length > 0,
    );
}

function getPurposeOptions(track: MergeTrackConfig): TrackPurpose[] {
    return getAllowedTrackPurposes(mergeType.value, track.type);
}

function reconcileDefaultTracks() {
    const defaultGroups = new Set<string>();
    for (const track of mergeTracksConfig.value) {
        if (!track.is_default || !track.type) continue;
        const key = `${track.type}:${track.purpose}`;
        if (defaultGroups.has(key)) track.is_default = false;
        else defaultGroups.add(key);
    }

    for (const requiredType of getRequiredContentTrackTypes(mergeType.value)) {
        const contentTracks = mergeTracksConfig.value.filter((track) => track.type === requiredType && track.purpose === "CONTENT");
        if (contentTracks.length > 0 && !contentTracks.some((track) => track.is_default)) {
            const firstTrack = contentTracks[0];
            if (firstTrack) {
                firstTrack.is_default = true;
            }
        }
    }
}

function normalizeMergeTracks(type: MediaType) {
    mergeTracksConfig.value = normalizeDraftTracksForMedia(type, mergeTracksConfig.value).map((track) => ({
        ...track,
        language: isLanguageTrackType(track.type) ? track.language : "",
    }));
}

function handleMergeTypeChange(value: unknown) {
    if (typeof value !== "string" || !compatibleMergeTypes.value.includes(value as MediaType)) return;
    mergeType.value = value as MediaType;
    normalizeMergeTracks(mergeType.value);
}

function handleTrackTypeChange(track: MergeTrackConfig, value: unknown) {
    if (typeof value !== "string" || !getTrackTypeOptions(track).includes(value as TrackType)) return;
    track.type = value as TrackType;
    const purposes = getPurposeOptions(track);
    if (!purposes.includes(track.purpose)) {
        track.purpose = purposes.includes(TrackPurpose.CONTENT) ? TrackPurpose.CONTENT : (purposes[0] ?? TrackPurpose.CONTENT);
    }
    if (!isLanguageTrackType(track.type)) track.language = "";
    reconcileDefaultTracks();
}

function handleTrackPurposeChange(track: MergeTrackConfig, value: unknown) {
    if (typeof value !== "string" || !getPurposeOptions(track).includes(value as TrackPurpose)) return;
    track.purpose = value as TrackPurpose;
    reconcileDefaultTracks();
}

function handleDefaultChange(track: MergeTrackConfig, checked: unknown) {
    if (!track.type) return;
    const shouldCheck = checked === true;
    const isRequiredGroup = track.purpose === "CONTENT" && getRequiredContentTrackTypes(mergeType.value).includes(track.type);
    if (!shouldCheck && isRequiredGroup && track.is_default) return;

    if (shouldCheck) {
        for (const candidate of mergeTracksConfig.value) {
            if (candidate !== track && candidate.type === track.type && candidate.purpose === track.purpose) {
                candidate.is_default = false;
            }
        }
    }
    track.is_default = shouldCheck;
}

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen && props.selectedDraftFiles.length > 0) {
            const firstFile = props.selectedDraftFiles[0];
            if (firstFile) {
                mergeTitle.value = firstFile.name.substring(0, firstFile.name.lastIndexOf(".")) || firstFile.name;
            }

            mergeTracksConfig.value = props.selectedDraftFiles.map((draft) => {
                const type = getAllowedFileTrackTypes(draft.name, draft.mime_type)[0] ?? null;
                return {
                    draft_file_id: draft.id,
                    name: draft.name,
                    mime_type: draft.mime_type,
                    type,
                    purpose: TrackPurpose.CONTENT,
                    quality: TrackQuality.HIGH,
                    is_default: false,
                    language: "",
                };
            });

            const compatibleTypes = getCompatibleMediaTypes(mergeTracksConfig.value);
            mergeType.value = compatibleTypes.includes(MediaType.VIDEO)
                ? MediaType.VIDEO
                : compatibleTypes.includes(MediaType.AUDIO)
                  ? MediaType.AUDIO
                  : (compatibleTypes[0] ?? MediaType.IMAGE);
            normalizeMergeTracks(mergeType.value);
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

    const payload = {
        media_drafts: [
            {
                temp_id: "merged_media",
                title: mergeTitle.value.trim(),
                type: mergeType.value,
                tracks: mergeTracksConfig.value.map((tr) => ({
                    draft_file_id: tr.draft_file_id,
                    type: tr.type!,
                    purpose: tr.purpose,
                    quality: tr.quality,
                    is_default: tr.is_default,
                    language: isLanguageTrackType(tr.type) ? tr.language.trim() || null : null,
                })),
            },
        ],
    };

    try {
        await importStore.commitMedia(props.libraryId, payload);
        emit("update:open", false);
        emit("merged", mergeTitle.value.trim());
        toast.success(t("draft_box.toasts.merge_success"), {
            description: t("draft_box.toasts.merge_success_desc", { title: mergeTitle.value.trim() }),
        });
        queryClient.invalidateQueries({ queryKey: ["media"] });
    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast.error(t("draft_box.toasts.merge_failed"), {
            description: msg,
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

                <!-- Tracks Table -->
                <div class="space-y-2">
                    <div class="text-xs font-semibold text-gray-500 flex items-center gap-1">
                        <Info class="w-3.5 h-3.5" /> {{ $t("draft_box.merge_dialog.configure_tracks") }}
                    </div>

                    <!-- Desktop and tablet track table -->
                    <div class="hidden overflow-x-auto rounded-lg border bg-gray-50/20 text-xs lg:block">
                        <table class="w-full min-w-[900px] table-fixed border-collapse text-left">
                            <thead>
                                <tr class="bg-gray-50 text-gray-500 font-medium border-b">
                                    <th class="w-[230px] p-3">{{ $t("media.headers.file") }}</th>
                                    <th class="w-[135px] p-3">{{ $t("media.headers.track_type") }}</th>
                                    <th class="w-[145px] p-3">{{ $t("media.headers.purpose") }}</th>
                                    <th class="w-[130px] p-3">{{ $t("media.headers.quality") }}</th>
                                    <th class="w-[90px] p-3 text-center">{{ $t("media.headers.default") }}</th>
                                    <th class="w-[150px] p-3">{{ $t("media.headers.language") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="track in mergeTracksConfig"
                                    :key="track.draft_file_id"
                                    class="border-b last:border-0 hover:bg-gray-50/50"
                                >
                                    <td class="p-3" :title="track.name">
                                        <div class="truncate font-medium">{{ track.name }}</div>
                                    </td>

                                    <!-- Track Type Select -->
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.type ?? undefined"
                                            :disabled="getTrackTypeOptions(track).length <= 1"
                                            @update:model-value="handleTrackTypeChange(track, $event)"
                                        >
                                            <SelectTrigger
                                                :aria-label="`Track type for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none disabled:opacity-100"
                                            >
                                                <SelectValue :placeholder="$t('media.unsupported_track')" />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="type in getTrackTypeOptions(track)" :key="type" :value="type">
                                                    {{ $t("media.track_types." + type) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>

                                    <!-- Purpose Select -->
                                    <td class="p-1.5">
                                        <Select
                                            :model-value="track.purpose"
                                            :disabled="getPurposeOptions(track).length <= 1"
                                            @update:model-value="handleTrackPurposeChange(track, $event)"
                                        >
                                            <SelectTrigger
                                                :aria-label="`Purpose for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none disabled:opacity-100"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem v-for="purpose in getPurposeOptions(track)" :key="purpose" :value="purpose">
                                                    {{ $t("media.purposes." + purpose) }}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>

                                    <!-- Quality Select -->
                                    <td class="p-1.5">
                                        <Select v-model="track.quality">
                                            <SelectTrigger
                                                :aria-label="`Quality for ${track.name}`"
                                                class="h-8 w-full border-0 bg-transparent px-2 text-xs shadow-none"
                                            >
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="HIGH">{{ $t("media.quality.high") }}</SelectItem>
                                                <SelectItem value="MEDIUM">{{ $t("media.quality.medium") }}</SelectItem>
                                                <SelectItem value="LOW">{{ $t("media.quality.low") }}</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </td>

                                    <!-- Default Checkbox -->
                                    <td class="p-3 text-center">
                                        <Checkbox
                                            :model-value="track.is_default"
                                            :aria-label="`Set ${track.name} as a default track`"
                                            class="mx-auto"
                                            @update:model-value="handleDefaultChange(track, $event)"
                                        />
                                    </td>

                                    <!-- Language Input -->
                                    <td class="p-1.5">
                                        <Input
                                            v-if="isLanguageTrackType(track.type)"
                                            v-model="track.language"
                                            placeholder="en-US"
                                            :aria-label="`Language for ${track.name}`"
                                            class="h-8 w-full min-w-0 border-0 bg-transparent px-2 text-xs shadow-none"
                                        />
                                        <span v-else class="block px-2 text-gray-400">{{ $t("media.not_applicable") }}</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <!-- Mobile track cards -->
                    <div class="space-y-3 lg:hidden">
                        <div
                            v-for="track in mergeTracksConfig"
                            :key="`mobile-${track.draft_file_id}`"
                            class="space-y-4 rounded-lg border bg-white p-3.5"
                        >
                            <div class="min-w-0 border-b pb-3">
                                <div class="truncate text-sm font-medium" :title="track.name">{{ track.name }}</div>
                                <div class="mt-0.5 truncate text-xs text-gray-500">{{ track.mime_type }}</div>
                            </div>

                            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.track_type") }}</Label>
                                    <Select
                                        :model-value="track.type ?? undefined"
                                        :disabled="getTrackTypeOptions(track).length <= 1"
                                        @update:model-value="handleTrackTypeChange(track, $event)"
                                    >
                                        <SelectTrigger
                                            :aria-label="`Track type for ${track.name}`"
                                            class="h-9 w-full text-xs disabled:opacity-100"
                                        >
                                            <SelectValue :placeholder="$t('media.unsupported_track')" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem v-for="type in getTrackTypeOptions(track)" :key="type" :value="type">
                                                {{ $t("media.track_types." + type) }}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.purpose") }}</Label>
                                    <Select
                                        :model-value="track.purpose"
                                        :disabled="getPurposeOptions(track).length <= 1"
                                        @update:model-value="handleTrackPurposeChange(track, $event)"
                                    >
                                        <SelectTrigger
                                            :aria-label="`Purpose for ${track.name}`"
                                            class="h-9 w-full text-xs disabled:opacity-100"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem v-for="purpose in getPurposeOptions(track)" :key="purpose" :value="purpose">
                                                {{ $t("media.purposes." + purpose) }}
                                            </SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div class="space-y-1.5">
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.quality") }}</Label>
                                    <Select v-model="track.quality">
                                        <SelectTrigger :aria-label="`Quality for ${track.name}`" class="h-9 w-full text-xs">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="HIGH">{{ $t("media.quality.high") }}</SelectItem>
                                            <SelectItem value="MEDIUM">{{ $t("media.quality.medium") }}</SelectItem>
                                            <SelectItem value="LOW">{{ $t("media.quality.low") }}</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>

                                <div v-if="isLanguageTrackType(track.type)" class="space-y-1.5">
                                    <Label class="text-xs text-gray-500">{{ $t("media.headers.language") }}</Label>
                                    <Input
                                        v-model="track.language"
                                        placeholder="en-US"
                                        :aria-label="`Language for ${track.name}`"
                                        class="h-9 text-xs"
                                    />
                                </div>
                            </div>

                            <div class="flex min-h-9 items-center justify-between gap-3 rounded-md bg-gray-50 px-3 py-2 text-sm">
                                <span>{{ $t("media.headers.default") }}</span>
                                <Checkbox
                                    :model-value="track.is_default"
                                    :aria-label="`Set ${track.name} as a default track`"
                                    @update:model-value="handleDefaultChange(track, $event)"
                                />
                            </div>
                        </div>
                    </div>

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
