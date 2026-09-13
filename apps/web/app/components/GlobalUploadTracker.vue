<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from "vue";
import { useImportStore } from "@/stores/import";
import { useLibraryStore } from "@/stores/library";
import { Button } from "@/components/ui/button";
import { Upload, Loader2, CheckCircle2, ChevronUp, ChevronDown, X, ArrowRight } from "@lucide/vue";

const importStore = useImportStore();
const libraryStore = useLibraryStore();
const router = useRouter();
const { t } = useI18n();

const isDragActive = ref(false);
const isExpanded = ref(false);
const showCompletedNotice = ref(false);
const completedCount = ref(0);
let dismissTimer: ReturnType<typeof setTimeout> | null = null;

const libraryId = computed(() => libraryStore.activeLibraryId);

const activeUploads = computed(() => importStore.uploadQueue.filter((q) => q.status === "uploading" || q.status === "pending"));

const overallProgress = computed(() => {
    if (activeUploads.value.length === 0) return 100;
    const sum = activeUploads.value.reduce((acc, curr) => acc + curr.progress, 0);
    return Math.round(sum / activeUploads.value.length);
});

// Drag & Drop handlers
let dragCounter = 0;

function isCreateMediaDialogOpen(): boolean {
    return document.querySelector("[data-create-media-dialog]") !== null;
}

function ignoreCreateMediaDrag(e: DragEvent): boolean {
    if (!isCreateMediaDialogOpen()) return false;
    e.preventDefault();
    dragCounter = 0;
    isDragActive.value = false;
    return true;
}

function handleDragEnter(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter++;
    if (dragCounter === 1) {
        isDragActive.value = true;
    }
}

function handleDragLeave(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        isDragActive.value = false;
    }
}

function handleDragOver(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
}

const MAX_CONCURRENT_UPLOADS = 3;

async function uploadFilesWithLimit(files: FileList) {
    const libId = libraryId.value;
    if (!libId) return;

    const fileArray = Array.from(files);
    const iterator = fileArray.values();
    const currentTotal = fileArray.length;

    const worker = async () => {
        for (const file of iterator) {
            try {
                await importStore.uploadFile(libId, file);
            } catch (err) {
                console.error(`Failed to upload ${file.name}:`, err);
            }
        }
    };

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT_UPLOADS, fileArray.length) }, worker);
    await Promise.all(workers);

    // Upload batch completed: show notification with link to /drafts
    completedCount.value = currentTotal;
    showCompletedNotice.value = true;
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = setTimeout(() => {
        showCompletedNotice.value = false;
    }, 8000);
}

async function handleDrop(e: DragEvent) {
    if (ignoreCreateMediaDrag(e)) return;
    e.preventDefault();
    dragCounter = 0;
    isDragActive.value = false;

    const files = e.dataTransfer?.files;
    if (files && files.length > 0 && libraryId.value) {
        await uploadFilesWithLimit(files);
    }
}

function navigateToDrafts() {
    showCompletedNotice.value = false;
    router.push("/drafts");
}

function dismissNotice() {
    showCompletedNotice.value = false;
    if (dismissTimer) clearTimeout(dismissTimer);
}

onMounted(() => {
    window.addEventListener("dragenter", handleDragEnter);
    window.addEventListener("dragleave", handleDragLeave);
    window.addEventListener("dragover", handleDragOver);
    window.addEventListener("drop", handleDrop);
});

onUnmounted(() => {
    window.removeEventListener("dragenter", handleDragEnter);
    window.removeEventListener("dragleave", handleDragLeave);
    window.removeEventListener("dragover", handleDragOver);
    window.removeEventListener("drop", handleDrop);
    if (dismissTimer) clearTimeout(dismissTimer);
});
</script>

<template>
    <!-- Full-screen Drag & Drop Overlay -->
    <Transition name="fade">
        <div
            v-if="isDragActive"
            class="fixed inset-0 z-50 flex flex-col items-center justify-center bg-zinc-950/70 backdrop-blur-md pointer-events-none transition-all duration-300 ease-in-out"
        >
            <div
                class="m-8 p-12 border-2 border-dashed border-white/50 rounded-3xl flex flex-col items-center gap-4 max-w-lg text-center bg-white/5 backdrop-blur-lg shadow-2xl"
            >
                <div class="w-20 h-20 rounded-2xl bg-white/10 flex items-center justify-center">
                    <Upload class="w-10 h-10 text-white animate-bounce" />
                </div>
                <h2 class="text-2xl font-semibold text-white tracking-tight">{{ $t("draft_box.drop_title") }}</h2>
                <p class="text-white/70 text-sm leading-relaxed">
                    {{ $t("draft_box.drop_desc") }}
                </p>
            </div>
        </div>
    </Transition>

    <!-- Sleek Bottom-Right Upload Tracker Widget -->
    <Transition name="slide-up">
        <div
            v-if="activeUploads.length > 0 || showCompletedNotice"
            class="fixed bottom-5 right-5 z-40 w-[calc(100vw-2.5rem)] sm:w-96 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-md border border-zinc-200/80 dark:border-zinc-800/80 rounded-2xl shadow-xl shadow-zinc-950/5 overflow-hidden text-xs select-none transition-all duration-200"
        >
            <!-- 1. Active Uploading State -->
            <div v-if="activeUploads.length > 0" class="p-3.5 flex flex-col gap-2.5">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2 font-medium text-zinc-800 dark:text-zinc-200">
                        <Loader2 class="w-4 h-4 animate-spin text-zinc-900 dark:text-zinc-100" />
                        <span>{{ $t("draft_box.uploading_background_tasks") }}</span>
                        <span
                            class="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded-full font-semibold text-zinc-600 dark:text-zinc-300"
                        >
                            {{ activeUploads.length }}
                        </span>
                    </div>

                    <div class="flex items-center gap-1">
                        <span class="font-semibold text-zinc-700 dark:text-zinc-300 tabular-nums"> {{ overallProgress }}% </span>
                        <button
                            type="button"
                            class="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 rounded-md transition-colors"
                            :title="isExpanded ? 'Collapse' : 'Expand'"
                            @click="isExpanded = !isExpanded"
                        >
                            <ChevronUp v-if="!isExpanded" class="w-3.5 h-3.5" />
                            <ChevronDown v-else class="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>

                <!-- Global Progress Bar -->
                <div class="w-full bg-zinc-100 dark:bg-zinc-800 rounded-full h-1.5 overflow-hidden">
                    <div
                        class="bg-zinc-900 dark:bg-zinc-100 h-full transition-all duration-300 rounded-full"
                        :style="{ width: `${overallProgress}%` }"
                    />
                </div>

                <!-- Detailed File Task List (Collapsible) -->
                <div
                    v-if="isExpanded"
                    class="mt-1 max-h-40 overflow-y-auto space-y-2 border-t border-zinc-100 dark:border-zinc-800/80 pt-2"
                >
                    <div
                        v-for="task in activeUploads"
                        :key="task.id"
                        class="flex items-center justify-between gap-3 text-zinc-600 dark:text-zinc-400"
                    >
                        <span class="truncate flex-1 font-mono text-xs">{{ task.name }}</span>
                        <div class="w-16 bg-zinc-100 dark:bg-zinc-800 rounded-full h-1 overflow-hidden shrink-0">
                            <div
                                class="bg-zinc-700 dark:bg-zinc-300 h-full transition-all duration-200"
                                :style="{ width: `${task.progress}%` }"
                            />
                        </div>
                        <span class="w-8 text-right text-xs tabular-nums shrink-0">{{ task.progress }}%</span>
                    </div>
                </div>
            </div>

            <!-- 2. Completed State Notice -->
            <div
                v-else-if="showCompletedNotice"
                class="p-3.5 flex items-center justify-between gap-3 bg-zinc-900 text-white dark:bg-zinc-800"
            >
                <div class="flex items-center gap-2.5 min-w-0">
                    <CheckCircle2 class="w-4 h-4 text-emerald-400 shrink-0" />
                    <span class="truncate font-medium text-xs">
                        {{ $t("draft_box.toasts.import_success", { count: completedCount }) }}
                    </span>
                </div>

                <div class="flex items-center gap-1.5 shrink-0">
                    <Button
                        size="sm"
                        variant="secondary"
                        class="h-7 px-2.5 text-xs font-medium gap-1 bg-white text-zinc-900 hover:bg-zinc-100 cursor-pointer shadow-xs active:scale-95"
                        @click="navigateToDrafts"
                    >
                        <span>{{ $t("draft_box.view_in_drafts") }}</span>
                        <ArrowRight class="w-3 h-3" />
                    </Button>
                    <button
                        type="button"
                        class="p-1 text-zinc-400 hover:text-white rounded-md transition-colors cursor-pointer"
                        @click="dismissNotice"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>
        </div>
    </Transition>
</template>

<style scoped>
.fade-enter-active,
.fade-leave-active {
    transition: opacity 0.2s ease;
}

.fade-enter-from,
.fade-leave-to {
    opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
    transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.slide-up-enter-from,
.slide-up-leave-to {
    opacity: 0;
    transform: translateY(12px) scale(0.97);
}
</style>
