<script setup lang="ts">
import type { AcceptableValue } from "reka-ui"
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/sonner"
import { useLibraryStore } from "@/stores/library"
import { CheckSquare, Loader2, MoveRight, X } from "@lucide/vue"

const props = withDefaults(defineProps<{
    postIds?: string[]
    mediaIds?: string[]
    allVisibleSelected?: boolean
    canSelectVisible?: boolean
}>(), {
    postIds: () => [],
    mediaIds: () => [],
    allVisibleSelected: false,
    canSelectVisible: false,
})

const emit = defineEmits<{
    moved: []
    cancel: []
    toggleVisible: []
}>()

const libraryStore = useLibraryStore()
const targetLibraryId = ref("")
const isMoving = ref(false)

const targetLibraries = computed(() =>
    libraryStore.libraries.filter((library) => library.id !== libraryStore.activeLibraryId),
)

const itemCount = computed(() => props.postIds.length + props.mediaIds.length)
const hasTargetLibrary = computed(() => targetLibraries.value.length > 0)

const itemSummary = computed(() => {
    const parts = []
    if (props.postIds.length > 0) {
        parts.push(`${props.postIds.length} post${props.postIds.length === 1 ? "" : "s"}`)
    }
    if (props.mediaIds.length > 0) {
        parts.push(`${props.mediaIds.length} media`)
    }
    return parts.join(" and ")
})

watch(
    targetLibraries,
    (libraries) => {
        if (!libraries.some((library) => library.id === targetLibraryId.value)) {
            targetLibraryId.value = libraries[0]?.id ?? ""
        }
    },
    { immediate: true },
)

const handleTargetChange = (value: AcceptableValue) => {
    if (typeof value === "string") {
        targetLibraryId.value = value
    }
}

const getMoveErrorDescription = (e: any) => {
    return e?.data?.message ||
        e?.data?.error ||
        e?.response?._data?.message ||
        e?.response?._data?.error ||
        e?.message ||
        "Something went wrong while moving the selected items."
}

const handleMove = async () => {
    if (itemCount.value === 0 || isMoving.value) return

    if (!targetLibraryId.value) {
        toast.warning("Choose a target library", {
            description: "Create or choose another library before moving items.",
        })
        return
    }

    try {
        isMoving.value = true
        await libraryStore.moveItems({
            postIds: props.postIds,
            mediaIds: props.mediaIds,
            targetLibraryId: targetLibraryId.value,
        })
        toast.success("Items moved", {
            description: `${itemSummary.value} moved to the selected library.`,
        })
        emit("moved")
    } catch (e: any) {
        toast.error("Failed to move items", {
            description: getMoveErrorDescription(e),
        })
    } finally {
        isMoving.value = false
    }
}
</script>

<template>
    <div class="pointer-events-none fixed inset-x-0 bottom-5 z-40 flex justify-center px-4">
        <div
            class="pointer-events-auto flex w-full max-w-4xl flex-col gap-3 rounded-lg border bg-white p-3 shadow-lg sm:flex-row sm:items-center sm:justify-between"
        >
            <div class="flex min-w-0 items-center gap-3">
                <div class="whitespace-nowrap tabular-nums text-sm font-semibold text-gray-900">
                    {{ itemCount }} selected
                </div>
                <div v-if="itemCount > 0" class="hidden truncate text-sm text-muted-foreground sm:block">
                    Move {{ itemSummary || "selected items" }} to
                </div>
                <div v-else class="hidden truncate text-sm text-muted-foreground sm:block">
                    Choose items to move
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    :disabled="!canSelectVisible || isMoving"
                    @click="emit('toggleVisible')"
                >
                    <CheckSquare />
                    {{ allVisibleSelected ? "Deselect visible" : "Select visible" }}
                </Button>
                <Select :model-value="targetLibraryId" @update:model-value="handleTargetChange">
                    <SelectTrigger class="h-9 w-[220px]">
                        <SelectValue :placeholder="hasTargetLibrary ? 'Choose library' : 'No target library'" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem
                                v-for="library in targetLibraries"
                                :key="library.id"
                                :value="library.id"
                            >
                                {{ library.name }}
                            </SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
                <Button
                    type="button"
                    size="sm"
                    :disabled="!hasTargetLibrary || itemCount === 0 || isMoving"
                    @click="handleMove"
                >
                    <Loader2 v-if="isMoving" class="animate-spin" />
                    <MoveRight v-else />
                    Move
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    :disabled="isMoving"
                    aria-label="Cancel selection"
                    @click="emit('cancel')"
                >
                    <X />
                </Button>
            </div>
        </div>
    </div>
</template>
