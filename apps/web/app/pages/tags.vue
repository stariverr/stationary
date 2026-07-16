<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { useTagStore, type TagItem } from "@/stores/tag";
import { useLibraryStore } from "@/stores/library";
import {
    Tag as TagIcon,
    Plus,
    Search,
    Edit2,
    GitMerge,
    Trash2,
    RotateCcw,
    Check,
    Ban,
    Loader2,
    AlertCircle,
    SlidersHorizontal,
    FolderCheck,
    X,
    FileText,
    Layers,
    Sparkles,
    ShieldAlert,
    ChevronRight,
    Info,
} from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "vue-sonner";

const tagStore = useTagStore();
const libraryStore = useLibraryStore();

const activeLibrary = computed(() => libraryStore.activeLibrary);
const searchQuery = ref("");
const activeTab = ref("active");

// Selected Tag for Inspector (clicked pill)
const selectedTag = ref<TagItem | null>(null);

// Multi-selection states
const checkedTagIds = ref<string[]>([]);
const isBatchLoading = ref(false);
const sortBy = ref<"name" | "post_count" | "media_count">("name");

// Active Inspector Tag & State
const activeInspectorTag = computed(() => {
    if (checkedTagIds.value.length === 1) {
        return tagStore.tags.find((tag) => tag.id === checkedTagIds.value[0]) || null;
    }
    return selectedTag.value;
});

const isBatchInspector = computed(() => checkedTagIds.value.length > 1);
const showSidebar = ref(false);

// Forms State (synchronized when activeInspectorTag changes)
const editName = ref("");
const editColor = ref<string>();
const editAliasesStr = ref("");
const mergeTargetId = ref<string | null>(null);
const aliasTargetId = ref<string | null>(null);

// Batch Color State
const batchColor = ref<string>();
const hasBatchColorSelected = ref(false);

watch(activeInspectorTag, (newTag) => {
    if (newTag) {
        editName.value = newTag.name;
        editColor.value = newTag.color || undefined;
        editAliasesStr.value = Array.isArray(newTag.aliases) ? newTag.aliases.join(", ") : "";
        mergeTargetId.value = null;
        aliasTargetId.value = null;
    } else {
        editName.value = "";
        editColor.value = undefined;
        editAliasesStr.value = "";
        mergeTargetId.value = null;
        aliasTargetId.value = null;
    }
});

watch(
    checkedTagIds,
    (newIds) => {
        if (newIds.length === 0) {
            batchColor.value = undefined;
            hasBatchColorSelected.value = false;
            if (!selectedTag.value) {
                showSidebar.value = false;
            }
        } else if (newIds.length === 1) {
            const tag = tagStore.tags.find((tag) => tag.id === newIds[0]);
            if (tag) {
                batchColor.value = tag.color || undefined;
                hasBatchColorSelected.value = true;
            }
        }
    },
    { deep: true },
);

// Color preset definitions
const colorPresets = [
    { name: "None", value: null },
    { name: "Rose", value: "#f43f5e" },
    { name: "Orange", value: "#f97316" },
    { name: "Amber", value: "#eab308" },
    { name: "Emerald", value: "#10b981" },
    { name: "Blue", value: "#3b82f6" },
    { name: "Indigo", value: "#6366f1" },
    { name: "Violet", value: "#8b5cf6" },
    { name: "Pink", value: "#ec4899" },
    { name: "OKLCH Emerald", value: "oklch(0.68 0.19 148)" },
    { name: "OKLCH Indigo", value: "oklch(0.55 0.22 274)" },
    { name: "OKLCH Amber", value: "oklch(0.77 0.17 76)" },
];

// Helper to normalize any color input (hex vs OKLCH/generic CSS colors)
const normalizeColor = (color: string | null): string => {
    if (!color) return "";
    const trimmed = color.trim();
    if (trimmed.startsWith("#") || /^(oklch|rgb|hsl)/i.test(trimmed)) {
        return trimmed;
    }
    // If it's a raw hex code (e.g. "6366f1"), prepend "#"
    if (/^[0-9a-fA-F]{3,8}$/.test(trimmed)) {
        return `#${trimmed}`;
    }
    return trimmed;
};

// Helper for Pill Tag badge styles based on DESIGN.md (with dynamic opacity mixing for OKLCH support)
const getTagBadgeStyle = (color: string | null, checked = false) => {
    if (!color) {
        return {
            backgroundColor: checked ? "#f4f4f5" : "#fafafa", // zinc-100 vs zinc-50
            color: "#52525b", // zinc-600 (Softer typography)
            borderColor: checked ? "#d4d4d8" : "#e4e4e7", // zinc-300 vs zinc-200
        };
    }
    const normalized = normalizeColor(color);
    return {
        color: normalized,
        backgroundColor: checked
            ? `color-mix(in srgb, ${normalized} 18%, transparent)`
            : `color-mix(in srgb, ${normalized} 12%, transparent)`,
        borderColor: checked ? `color-mix(in srgb, ${normalized} 44%, transparent)` : `color-mix(in srgb, ${normalized} 27%, transparent)`,
    };
};

// Input validation handlers
const handleColorInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    let val = target.value.trim();
    if (val) {
        if (/^(oklch|rgb|hsl|#)/i.test(val)) {
            // Keep as is
        } else if (/^[0-9a-fA-F]{3,8}$/.test(val)) {
            val = "#" + val;
        }
    }
    editColor.value = val || undefined;
};

const handleNewColorInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    let val = target.value.trim();
    if (val) {
        if (/^(oklch|rgb|hsl|#)/i.test(val)) {
            // Keep as is
        } else if (/^[0-9a-fA-F]{3,8}$/.test(val)) {
            val = "#" + val;
        }
    }
    newTagColor.value = val || undefined;
};

const handleBatchColorInput = (event: Event) => {
    const target = event.target as HTMLInputElement;
    let val = target.value.trim();
    if (val) {
        if (/^(oklch|rgb|hsl|#)/i.test(val)) {
            // Keep as is
        } else if (/^[0-9a-fA-F]{3,8}$/.test(val)) {
            val = "#" + val;
        }
        hasBatchColorSelected.value = true;
    } else {
        hasBatchColorSelected.value = false;
    }
    batchColor.value = val || undefined;
};

// Filtered tags based on search query
const filteredActiveTags = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return tagStore.activeTags;
    return tagStore.activeTags.filter(
        (t) => t.name.toLowerCase().includes(query) || (t.aliases && t.aliases.some((alias) => alias.toLowerCase().includes(query))),
    );
});

const filteredCandidateTags = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return tagStore.candidateTags;
    return tagStore.candidateTags.filter(
        (t) => t.name.toLowerCase().includes(query) || (t.aliases && t.aliases.some((alias) => alias.toLowerCase().includes(query))),
    );
});

const filteredIgnoredTags = computed(() => {
    const query = searchQuery.value.trim().toLowerCase();
    if (!query) return tagStore.ignoredTags;
    return tagStore.ignoredTags.filter(
        (t) => t.name.toLowerCase().includes(query) || (t.aliases && t.aliases.some((alias) => alias.toLowerCase().includes(query))),
    );
});

// Total counts for summary calculations
const totalAssociations = computed(() => {
    return tagStore.activeTags.reduce((sum, t) => sum + (t.post_count || 0) + (t.media_count || 0), 0);
});

// CREATE TAG STATE
const isCreateOpen = ref(false);
const newTagName = ref("");
const newTagColor = ref<string>();
const newTagAliasesStr = ref("");

const handleCreateTag = async () => {
    if (!newTagName.value.trim()) {
        toast.warning(t("tags.toast_name_required"));
        return;
    }
    try {
        const parsedAliases = newTagAliasesStr.value
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean);

        const created = await tagStore.createTag({
            name: newTagName.value.trim(),
            color: newTagColor.value,
            aliases: parsedAliases,
        });
        toast.success(t("tags.toast_create_success", { name: created.name }));
        isCreateOpen.value = false;
        newTagName.value = "";
        newTagColor.value = undefined;
        newTagAliasesStr.value = "";

        // Select the newly created tag automatically
        const allTags = tagStore.tags;
        const matched = allTags.find((tag) => tag.normalized_name === created.normalized_name);
        if (matched) {
            selectedTag.value = matched;
            checkedTagIds.value = [];
            showSidebar.value = true;
        }
    } catch (e: any) {
        toast.error(t("tags.toast_create_failed"), {
            description: e.message || String(e),
        });
    }
};

// SAVE TAG CHANGES FROM INSPECTOR
const handleSaveInspectorChanges = async () => {
    if (!activeInspectorTag.value) return;
    if (!editName.value.trim()) {
        toast.warning(t("tags.toast_name_required"));
        return;
    }
    try {
        const parsedAliases = editAliasesStr.value
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean);

        const updated = await tagStore.updateTag({
            id: activeInspectorTag.value.id,
            name: editName.value.trim(),
            color: editColor.value === undefined ? null : editColor.value,
            aliases: parsedAliases,
        });
        toast.success(t("tags.toast_update_success"));

        // Update local reference
        if (selectedTag.value && selectedTag.value.id === updated.id) {
            selectedTag.value = { ...selectedTag.value, ...updated };
        }
        const idx = checkedTagIds.value.indexOf(updated.id);
        if (idx > -1) {
            // Keep checked
        }
    } catch (e: any) {
        toast.error(t("tags.toast_update_failed"), {
            description: e.message || String(e),
        });
    }
};

const handleDeleteTag = async (tagId: string) => {
    if (!confirm(confirmDeleteText.value)) return;
    try {
        await tagStore.deleteTag(tagId);
        toast.success(t("tags.toast_delete_success"));
        selectedTag.value = null;
        checkedTagIds.value = checkedTagIds.value.filter((id) => id !== tagId);
    } catch (e: any) {
        toast.error(t("tags.toast_delete_failed"), {
            description: e.message || String(e),
        });
    }
};

const handleMergeTags = async (retainAsAlias: boolean) => {
    const targetId = retainAsAlias ? aliasTargetId.value : mergeTargetId.value;
    if (!activeInspectorTag.value || !targetId) return;

    const targetTag = tagStore.tags.find((t) => t.id === targetId);
    if (!targetTag) return;

    if (!retainAsAlias) {
        const confirmMsg = t("tags.confirm_merge_delete_prompt", {
            source: activeInspectorTag.value.name,
            target: targetTag.name,
        });
        if (!confirm(confirmMsg)) return;
    }

    try {
        await tagStore.mergeTags({
            sourceTagId: activeInspectorTag.value.id,
            targetTagId: targetId,
            retainAsAlias,
        });
        if (retainAsAlias) {
            toast.success(t("tags.toast_merge_success"));
        } else {
            toast.success(t("tags.toast_merge_delete_success"));
        }
        selectedTag.value = null;
        checkedTagIds.value = checkedTagIds.value.filter((id) => id !== activeInspectorTag.value?.id);
    } catch (e: any) {
        if (retainAsAlias) {
            toast.error(t("tags.toast_merge_failed"), {
                description: e.message || String(e),
            });
        } else {
            toast.error(t("tags.toast_merge_delete_failed"), {
                description: e.message || String(e),
            });
        }
    }
};

// QUICK ACTIONS FOR CANDIDATES & IGNORED
const handlePromoteTag = async (tag: TagItem) => {
    try {
        await tagStore.updateTag({
            id: tag.id,
            status: "ACTIVE",
        });
        toast.success(t("tags.toast_approve_success", { name: tag.name }));
        if (activeInspectorTag.value?.id === tag.id) {
            selectedTag.value = null;
            checkedTagIds.value = checkedTagIds.value.filter((id) => id !== tag.id);
        }
    } catch (e: any) {
        toast.error(t("tags.toast_approve_failed", { name: tag.name }), {
            description: e.message || String(e),
        });
    }
};

const handleIgnoreTag = async (tag: TagItem) => {
    if (!confirm(confirmIgnoreText.value)) return;
    try {
        await tagStore.updateTag({
            id: tag.id,
            status: "IGNORED",
        });
        toast.success(t("tags.toast_ignore_success", { name: tag.name }));
        if (activeInspectorTag.value?.id === tag.id) {
            selectedTag.value = null;
            checkedTagIds.value = checkedTagIds.value.filter((id) => id !== tag.id);
        }
    } catch (e: any) {
        toast.error(t("tags.toast_ignore_failed", { name: tag.name }), {
            description: e.message || String(e),
        });
    }
};

const handleRestoreTag = async (tag: TagItem) => {
    try {
        await tagStore.updateTag({
            id: tag.id,
            status: "ACTIVE",
        });
        toast.success(t("tags.toast_restore_success", { name: tag.name }));
        if (activeInspectorTag.value?.id === tag.id) {
            selectedTag.value = null;
            checkedTagIds.value = checkedTagIds.value.filter((id) => id !== tag.id);
        }
    } catch (e: any) {
        toast.error(t("tags.toast_restore_failed", { name: tag.name }), {
            description: e.message || String(e),
        });
    }
};

// Dropdown options of other active tags for merging
const mergeOptions = computed(() => {
    if (!activeInspectorTag.value) return [];
    return tagStore.activeTags.filter((t) => t.id !== activeInspectorTag.value?.id);
});

const sortedFlatTags = computed(() => {
    const list = [...currentFilteredTags.value];
    if (sortBy.value === "post_count") {
        return list.sort((a, b) => b.post_count - a.post_count);
    }
    if (sortBy.value === "media_count") {
        return list.sort((a, b) => b.media_count - a.media_count);
    }
    return list.sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

// Watch tab switches to clear selection
watch(activeTab, () => {
    selectedTag.value = null;
    checkedTagIds.value = [];
    showSidebar.value = false;
});

const subtitleText = computed(() => {
    const libName = activeLibrary.value?.name;
    if (!libName || libName === "Default Library") {
        return "";
    }
    return libName;
});

const currentFilteredTags = computed(() => {
    if (activeTab.value === "active") return filteredActiveTags.value;
    if (activeTab.value === "candidate") return filteredCandidateTags.value;
    return filteredIgnoredTags.value;
});

const isAllSelected = computed(() => {
    const tags = currentFilteredTags.value;
    if (tags.length === 0) return false;
    return tags.every((t) => checkedTagIds.value.includes(t.id));
});

const isSomeSelected = computed(() => {
    const tags = currentFilteredTags.value;
    if (tags.length === 0) return false;
    return tags.some((t) => checkedTagIds.value.includes(t.id));
});

const toggleSelectAll = () => {
    if (isAllSelected.value) {
        // Deselect all for current tab
        const idsToRemove = currentFilteredTags.value.map((t) => t.id);
        checkedTagIds.value = checkedTagIds.value.filter((id) => !idsToRemove.includes(id));
    } else {
        // Select all for current tab
        const idsToAdd = currentFilteredTags.value.map((t) => t.id);
        const newIds = new Set([...checkedTagIds.value, ...idsToAdd]);
        checkedTagIds.value = Array.from(newIds);
    }
};

const isChecked = (id: string) => checkedTagIds.value.includes(id);

const toggleCheck = (id: string) => {
    console.log("[debug toggleCheck] toggling tag ID:", id);
    const idx = checkedTagIds.value.indexOf(id);
    if (idx > -1) {
        checkedTagIds.value.splice(idx, 1);
    } else {
        checkedTagIds.value.push(id);
    }
    console.log("[debug toggleCheck] checkedTagIds current state:", JSON.stringify(checkedTagIds.value));
};

const handleBatchPromote = async () => {
    const ids = [...checkedTagIds.value];
    if (ids.length === 0) return;
    isBatchLoading.value = true;
    try {
        await Promise.all(
            ids.map((id) =>
                tagStore.updateTag({
                    id,
                    status: "ACTIVE",
                }),
            ),
        );
        toast.success(t("tags.toast_batch_approve_success", { count: ids.length }));
        checkedTagIds.value = [];
        selectedTag.value = null;
    } catch (e: any) {
        toast.error(t("tags.toast_batch_approve_failed"), {
            description: e.message || String(e),
        });
    } finally {
        isBatchLoading.value = false;
    }
};

const handleBatchIgnore = async () => {
    const ids = [...checkedTagIds.value];
    if (ids.length === 0) return;
    if (!confirm(t("tags.confirm_ignore_batch", { count: ids.length }))) return;
    isBatchLoading.value = true;
    try {
        await Promise.all(
            ids.map((id) =>
                tagStore.updateTag({
                    id,
                    status: "IGNORED",
                }),
            ),
        );
        toast.success(t("tags.toast_batch_ignore_success", { count: ids.length }));
        checkedTagIds.value = [];
        selectedTag.value = null;
    } catch (e: any) {
        toast.error(t("tags.toast_batch_ignore_failed"), {
            description: e.message || String(e),
        });
    } finally {
        isBatchLoading.value = false;
    }
};

const handleBatchRestore = async () => {
    const ids = [...checkedTagIds.value];
    if (ids.length === 0) return;
    isBatchLoading.value = true;
    try {
        await Promise.all(
            ids.map((id) =>
                tagStore.updateTag({
                    id,
                    status: "ACTIVE",
                }),
            ),
        );
        toast.success(t("tags.toast_batch_restore_success", { count: ids.length }));
        checkedTagIds.value = [];
        selectedTag.value = null;
    } catch (e: any) {
        toast.error(t("tags.toast_batch_restore_failed"), {
            description: e.message || String(e),
        });
    } finally {
        isBatchLoading.value = false;
    }
};

const handleBatchDelete = async () => {
    const ids = [...checkedTagIds.value];
    if (ids.length === 0) return;
    if (!confirm(t("tags.confirm_delete_batch", { count: ids.length }))) return;
    isBatchLoading.value = true;
    try {
        await Promise.all(ids.map((id) => tagStore.deleteTag(id)));
        toast.success(t("tags.toast_batch_delete_success", { count: ids.length }));
        checkedTagIds.value = [];
        selectedTag.value = null;
    } catch (e: any) {
        toast.error(t("tags.toast_batch_delete_failed"), {
            description: e.message || String(e),
        });
    } finally {
        isBatchLoading.value = false;
    }
};

const handleBatchSaveColor = async () => {
    const ids = [...checkedTagIds.value];
    if (ids.length === 0) return;
    isBatchLoading.value = true;
    try {
        await Promise.all(
            ids.map((id) =>
                tagStore.updateTag({
                    id,
                    color: batchColor.value === undefined ? null : batchColor.value,
                }),
            ),
        );
        toast.success(t("tags.toast_batch_color_success", { count: ids.length }));
    } catch (e: any) {
        toast.error(t("tags.toast_batch_color_failed"), {
            description: e.message || String(e),
        });
    } finally {
        isBatchLoading.value = false;
    }
};

// Localizations
const { t } = useI18n();
const pageTitle = computed(() => t("tags.title") || "Tag Management");
const activeTabLabel = computed(() => t("tags.active_tab") || "Active Tags");
const candidateTabLabel = computed(() => t("tags.candidate_tab") || "Candidate Tags");
const ignoredTabLabel = computed(() => t("tags.ignored_tab") || "Ignored Tags");
const createBtnText = computed(() => t("tags.create_btn") || "Create Tag");
const searchPlaceholder = computed(() => t("tags.search_placeholder") || "Search tag name...");
const noTagsText = computed(() => t("tags.no_tags") || "No tags found");
const selectAllText = computed(() => t("tags.select_all") || "Select All");
const confirmDeleteText = computed(
    () =>
        t("tags.confirm_delete") ||
        "Are you sure you want to permanently delete this tag? This will clear all existing associations and cannot be recovered!",
);
const confirmIgnoreText = computed(
    () =>
        t("tags.confirm_ignore") ||
        "Are you sure you want to ignore this tag? This will clear all existing associations, and future imports of this tag will be automatically skipped!",
);

const getInitialLetter = (name: string): string => {
    if (!name) return "#";
    const firstChar = name.trim().charAt(0);
    if (/^[A-Za-z]/.test(firstChar)) {
        return firstChar.toUpperCase();
    }
    if (/^[0-9]/.test(firstChar)) {
        return "#";
    }

    // Boundary character mapping for Pinyin initials comparison using localeCompare
    const pinyinBoundaries = [
        { initial: "A", char: "啊" },
        { initial: "B", char: "芭" },
        { initial: "C", char: "擦" },
        { initial: "D", char: "搭" },
        { initial: "E", char: "蛾" },
        { initial: "F", char: "发" },
        { initial: "G", char: "噶" },
        { initial: "H", char: "哈" },
        { initial: "J", char: "击" },
        { initial: "K", char: "喀" },
        { initial: "L", char: "垃" },
        { initial: "M", char: "妈" },
        { initial: "N", char: "拿" },
        { initial: "O", char: "噢" },
        { initial: "P", char: "啪" },
        { initial: "Q", char: "期" },
        { initial: "R", char: "然" },
        { initial: "S", char: "撒" },
        { initial: "T", char: "塌" },
        { initial: "W", char: "挖" },
        { initial: "X", char: "昔" },
        { initial: "Y", char: "压" },
        { initial: "Z", char: "匝" },
    ];

    for (let i = pinyinBoundaries.length - 1; i >= 0; i--) {
        const boundary = pinyinBoundaries[i];
        if (boundary && firstChar.localeCompare(boundary.char, "zh") >= 0) {
            return boundary.initial;
        }
    }

    return "#";
};

// Computed grouped tags sorted alphabetically
const groupedTags = computed(() => {
    const groups: Record<string, typeof currentFilteredTags.value> = {};

    currentFilteredTags.value.forEach((tag) => {
        const initial = getInitialLetter(tag.name);
        if (!groups[initial]) {
            groups[initial] = [];
        }
        groups[initial].push(tag);
    });

    // Sort tag lists within each group alphabetically by name
    Object.keys(groups).forEach((key) => {
        const group = groups[key];
        if (group) {
            group.sort((a, b) => a.name.localeCompare(b.name, "zh"));
        }
    });

    // Sort group keys alphabetically, keeping '#' at the top
    const sortedKeys = Object.keys(groups).sort((a, b) => {
        if (a === "#") return -1;
        if (b === "#") return 1;
        return a.localeCompare(b);
    });

    return sortedKeys.map((key) => ({
        initial: key,
        tags: groups[key] || [],
    }));
});
</script>

<template>
    <div class="h-full flex flex-col bg-white overflow-hidden font-sans select-none">
        <!-- Top Navigation Header -->
        <header
            class="border-b border-zinc-200 px-4 md:px-8 py-3 md:py-4 shrink-0 flex flex-col sm:flex-row sm:items-center justify-between gap-3 md:gap-4 bg-white"
        >
            <div class="flex items-center gap-3">
                <div class="p-1.5 bg-zinc-50 border border-zinc-150 rounded-lg">
                    <TagIcon class="w-4 h-4 text-zinc-700" />
                </div>
                <div>
                    <h1 class="text-sm font-bold tracking-tight text-zinc-900 leading-none">{{ pageTitle }}</h1>
                    <span v-if="subtitleText" class="text-xs text-zinc-500 font-semibold flex items-center gap-1.5 mt-1.5">
                        <SlidersHorizontal class="w-3 h-3 text-zinc-400" />
                        <span>{{ subtitleText }}</span>
                    </span>
                </div>
            </div>

            <div class="flex items-center gap-2.5 sm:gap-3 w-full sm:w-auto justify-between sm:justify-start">
                <!-- Search bar -->
                <div class="relative w-full sm:w-64">
                    <Search class="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                    <Input
                        v-model="searchQuery"
                        type="text"
                        :placeholder="searchPlaceholder"
                        class="pl-8 pr-7 h-9 w-full bg-zinc-50 hover:bg-zinc-100/50 focus:bg-white text-xs rounded-lg border border-zinc-200 focus:ring-1 focus:ring-zinc-950 transition-all duration-200 placeholder-zinc-500 text-zinc-800"
                    />
                    <button
                        v-if="searchQuery"
                        @click="searchQuery = ''"
                        class="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-650 transition-colors"
                    >
                        <X class="w-3.5 h-3.5" />
                    </button>
                </div>

                <Button
                    @click="isCreateOpen = true"
                    class="h-9 gap-1 px-3 bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg font-bold text-xs cursor-pointer shadow-sm transition-colors duration-200 shrink-0"
                >
                    <Plus class="w-3.5 h-3.5" />
                    <span>{{ createBtnText }}</span>
                </Button>
            </div>
        </header>

        <!-- Main Workplace (Collapsible side-panel layout on cool canvas) -->
        <div class="flex-1 flex p-4 md:p-6 min-h-0 bg-[#f9fafb] relative gap-4 md:gap-6 overflow-hidden">
            <!-- Column 1: Main Tag Grid Card -->
            <div
                class="flex-1 bg-white rounded-2xl border border-zinc-200/60 shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden flex flex-col min-w-0 relative"
            >
                <!-- Unified Card Header (Tabs & Toolbar) -->
                <div
                    class="px-4 md:px-6 py-2.5 sm:py-0 border-b border-zinc-200 bg-[#fbfbfb] flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 sm:h-12 shrink-0 select-none"
                >
                    <!-- Left: Underline Tab triggers using shadcn Tabs -->
                    <Tabs
                        :model-value="activeTab"
                        @update:model-value="activeTab = $event as string"
                        class="h-10 sm:h-full flex items-center w-full sm:w-auto"
                    >
                        <TabsList
                            class="bg-transparent border-0 h-10 sm:h-full p-0 flex gap-4 md:gap-6 w-full sm:w-auto justify-between sm:justify-start"
                        >
                            <TabsTrigger
                                v-for="tab in ['active', 'candidate', 'ignored']"
                                :key="tab"
                                :value="tab"
                                class="relative h-full px-1 text-xs sm:text-sm font-bold tracking-tight transition-all duration-200 cursor-pointer flex items-center gap-1 sm:gap-1.5 focus-visible:ring-0 focus-visible:outline-none rounded-none text-zinc-400 hover:text-zinc-700 bg-transparent shadow-none border-none data-[state=active]:bg-transparent dark:data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:text-zinc-900 pb-0 pt-0"
                            >
                                <span>{{
                                    tab === "active" ? activeTabLabel : tab === "candidate" ? candidateTabLabel : ignoredTabLabel
                                }}</span>
                                <span
                                    class="text-[10px] sm:text-xs font-bold px-1.5 py-0.5 rounded-full font-mono transition-colors"
                                    :class="activeTab === tab ? 'bg-zinc-150 text-zinc-800' : 'bg-zinc-50 text-zinc-500'"
                                >
                                    {{
                                        tab === "active"
                                            ? tagStore.activeTags.length
                                            : tab === "candidate"
                                              ? tagStore.candidateTags.length
                                              : tagStore.ignoredTags.length
                                    }}
                                </span>
                                <!-- Sleek bottom indicator line -->
                                <div v-if="activeTab === tab" class="absolute bottom-0 inset-x-0 h-[2px] bg-zinc-800 rounded-full"></div>
                            </TabsTrigger>
                        </TabsList>
                    </Tabs>

                    <!-- Right: Select All & Sort Selector -->
                    <div class="flex items-center justify-between sm:justify-end gap-3 sm:gap-4 text-xs font-semibold w-full sm:w-auto">
                        <!-- Select All Checkbox -->
                        <div class="flex items-center gap-2 select-none cursor-pointer group" @click="toggleSelectAll">
                            <Checkbox
                                :model-value="isAllSelected ? true : isSomeSelected ? 'indeterminate' : false"
                                class="w-4 h-4 text-zinc-950 focus-visible:ring-zinc-950 pointer-events-none"
                            />
                            <span class="text-xs sm:text-sm font-medium text-zinc-500 group-hover:text-zinc-800 transition-colors">{{
                                selectAllText
                            }}</span>
                        </div>

                        <div v-if="checkedTagIds.length > 0" class="h-3.5 w-[1px] bg-zinc-250"></div>

                        <!-- Batch Action Button -->
                        <Button
                            v-if="checkedTagIds.length > 0"
                            @click="showSidebar = true"
                            variant="outline"
                            class="h-8 gap-1.5 px-2.5 border-zinc-200 bg-zinc-50 hover:bg-zinc-100/50 text-zinc-700 font-bold text-xs cursor-pointer shadow-sm rounded-lg animate-fade-in"
                        >
                            <SlidersHorizontal class="w-3.5 h-3.5 text-zinc-500" />
                            <span>{{ t("tags.batch_inspector_title") }} ({{ checkedTagIds.length }})</span>
                        </Button>

                        <div class="h-3.5 w-[1px] bg-zinc-250"></div>

                        <!-- Sort By dropdown -->
                        <div class="flex items-center gap-2">
                            <span class="text-xs sm:text-sm font-medium text-zinc-500">{{ t("tags.sort_by") }}</span>
                            <Select v-model="sortBy">
                                <SelectTrigger
                                    class="w-24 sm:w-32 bg-zinc-50 border border-zinc-200 rounded-lg h-8 text-xs sm:text-sm text-zinc-700 font-medium focus:ring-1 focus:ring-zinc-950 cursor-pointer hover:bg-zinc-100/50 transition-colors"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent class="bg-white border-zinc-200 rounded-lg shadow-xl">
                                    <SelectItem value="name" class="text-xs sm:text-sm cursor-pointer rounded">{{
                                        t("tags.sort_name")
                                    }}</SelectItem>
                                    <SelectItem value="post_count" class="text-xs sm:text-sm cursor-pointer rounded">{{
                                        t("tags.sort_post_count")
                                    }}</SelectItem>
                                    <SelectItem value="media_count" class="text-xs sm:text-sm cursor-pointer rounded">{{
                                        t("tags.sort_media_count")
                                    }}</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </div>

                <!-- Scrollable Grid Content -->
                <div
                    class="flex-1 overflow-y-auto min-h-0 p-4 md:p-6 relative animate-fade-in"
                    @click.self="
                        selectedTag = null;
                        checkedTagIds = [];
                        showSidebar = false;
                    "
                >
                    <div v-if="tagStore.isLoading" class="h-48 flex flex-col items-center justify-center">
                        <Loader2 class="w-6 h-6 animate-spin text-zinc-400" />
                        <span class="text-xs text-zinc-400 mt-2 font-medium">{{ t("tags.loading") }}</span>
                    </div>

                    <div
                        v-else-if="currentFilteredTags.length === 0"
                        class="h-48 flex flex-col items-center justify-center text-center text-zinc-400"
                    >
                        <Info class="w-8 h-8 text-zinc-300 mb-2" />
                        <p class="text-xs">{{ noTagsText }}</p>
                    </div>

                    <!-- Sorted Grid Layout Rendering -->
                    <template v-else>
                        <!-- Grouped alphabetically by name initial -->
                        <div v-if="sortBy === 'name'" class="space-y-6">
                            <div v-for="group in groupedTags" :key="group.initial" class="space-y-2">
                                <h3 class="text-xs font-bold text-zinc-400 uppercase select-none sticky top-0 bg-white py-1 z-10">
                                    {{ group.initial }}
                                </h3>
                                <div class="flex flex-wrap gap-2.5">
                                    <div
                                        v-for="tag in group.tags"
                                        :key="tag.id"
                                        @click="
                                            selectedTag = tag;
                                            checkedTagIds = [];
                                            showSidebar = true;
                                        "
                                        class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border transition-all duration-150 cursor-pointer select-none group text-sm font-semibold"
                                        :style="getTagBadgeStyle(tag.color, isChecked(tag.id))"
                                        :class="[
                                            activeInspectorTag?.id === tag.id
                                                ? 'ring-2 ring-zinc-900 ring-offset-1 scale-[1.02] font-bold shadow-sm'
                                                : '',
                                        ]"
                                    >
                                        <div @click.stop class="flex items-center">
                                            <Checkbox
                                                :model-value="isChecked(tag.id)"
                                                @update:model-value="toggleCheck(tag.id)"
                                                class="w-3.5 h-3.5 border-zinc-300 text-zinc-900 focus-visible:ring-zinc-950 cursor-pointer"
                                            />
                                        </div>
                                        <span class="opacity-40 font-normal">#</span>
                                        <span>{{ tag.name }}</span>
                                        <span
                                            class="text-[10px] px-1.5 py-0.5 rounded-full font-mono font-bold"
                                            :class="[
                                                activeInspectorTag?.id === tag.id ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-500',
                                            ]"
                                        >
                                            {{ tag.post_count + tag.media_count }}
                                        </span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Flat list for Count-based Sorts -->
                        <div v-else class="flex flex-wrap gap-2.5">
                            <div
                                v-for="tag in sortedFlatTags"
                                :key="tag.id"
                                @click="
                                    selectedTag = tag;
                                    checkedTagIds = [];
                                    showSidebar = true;
                                "
                                class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border transition-all duration-150 cursor-pointer select-none group text-sm font-semibold"
                                :style="getTagBadgeStyle(tag.color, isChecked(tag.id))"
                                :class="[
                                    activeInspectorTag?.id === tag.id
                                        ? 'ring-2 ring-zinc-900 ring-offset-1 scale-[1.02] font-bold shadow-sm'
                                        : '',
                                ]"
                            >
                                <div @click.stop class="flex items-center">
                                    <Checkbox
                                        :model-value="isChecked(tag.id)"
                                        @update:model-value="toggleCheck(tag.id)"
                                        class="w-3.5 h-3.5 border-zinc-300 text-zinc-900 focus-visible:ring-zinc-950 cursor-pointer"
                                    />
                                </div>
                                <span class="opacity-40 font-normal">#</span>
                                <span>{{ tag.name }}</span>
                                <span
                                    class="text-[10px] px-1.5 py-0.5 rounded-full font-mono font-bold"
                                    :class="[activeInspectorTag?.id === tag.id ? 'bg-zinc-800 text-white' : 'bg-zinc-100 text-zinc-500']"
                                >
                                    {{ sortBy === "post_count" ? tag.post_count : tag.media_count }}
                                </span>
                            </div>
                        </div>
                    </template>
                </div>
            </div>

            <!-- Backdrop Overlay for Mobile -->
            <div
                v-if="showSidebar"
                class="fixed inset-0 bg-black/10 backdrop-blur-xs z-30 md:hidden animate-fade-in"
                @click="
                    selectedTag = null;
                    checkedTagIds = [];
                    showSidebar = false;
                "
            ></div>

            <!-- Collapsible Sidebar Wrapper (Single or Batch Inspector) -->
            <transition name="side-panel">
                <div
                    v-if="showSidebar"
                    class="fixed inset-y-4 right-4 md:relative md:inset-y-0 md:right-0 z-45 w-[calc(100%-2rem)] sm:w-96 bg-white border border-zinc-200/60 shadow-2xl md:shadow-[0_1px_2px_rgba(0,0,0,0.02)] rounded-2xl flex flex-col select-none overflow-hidden shrink-0 h-[calc(100dvh-2rem)] md:h-full"
                >
                    <!-- BATCH INSPECTOR TEMPLATE -->
                    <template v-if="isBatchInspector">
                        <!-- Inspector Header -->
                        <div class="px-6 py-4 border-b border-zinc-150 bg-[#fbfbfb] flex items-center justify-between shrink-0 h-11">
                            <div class="flex items-center gap-2">
                                <span class="text-xs font-bold text-zinc-500 uppercase tracking-wider">{{
                                    t("tags.batch_inspector_title")
                                }}</span>
                                <span
                                    class="text-[10px] font-bold bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-md px-2 py-0.5 font-mono"
                                >
                                    {{ checkedTagIds.length }}
                                </span>
                            </div>
                            <button
                                @click="
                                    checkedTagIds = [];
                                    showSidebar = false;
                                "
                                class="p-1 hover:bg-zinc-100 rounded-lg text-zinc-400 hover:text-zinc-650 transition-colors cursor-pointer"
                            >
                                <X class="w-4 h-4" />
                            </button>
                        </div>

                        <!-- Inspector Content -->
                        <div class="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
                            <!-- List of selected tags -->
                            <div class="space-y-2">
                                <span class="text-xs text-zinc-500 font-bold block uppercase tracking-wider">{{
                                    t("tags.selected_count", { count: checkedTagIds.length })
                                }}</span>
                                <div
                                    class="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto p-2 bg-zinc-50/50 border border-zinc-150 rounded-xl"
                                >
                                    <div
                                        v-for="id in checkedTagIds"
                                        :key="id"
                                        class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold border"
                                        :style="getTagBadgeStyle(tagStore.tags.find((tag) => tag.id === id)?.color || null)"
                                    >
                                        <span class="opacity-50">#</span>
                                        <span>{{ tagStore.tags.find((tag) => tag.id === id)?.name }}</span>
                                    </div>
                                </div>
                            </div>

                            <!-- Accent color for batch -->
                            <div class="space-y-2.5 border-t border-zinc-100 pt-4">
                                <Label class="text-xs font-semibold text-zinc-700 uppercase tracking-wider">{{
                                    t("tags.batch_edit_color")
                                }}</Label>
                                <div class="flex flex-wrap gap-2">
                                    <button
                                        v-for="preset in colorPresets"
                                        :key="preset.name"
                                        type="button"
                                        @click="
                                            batchColor = preset.value || undefined;
                                            hasBatchColorSelected = true;
                                        "
                                        class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-200 hover:scale-110 cursor-pointer"
                                        :class="[
                                            hasBatchColorSelected && batchColor === (preset.value ?? undefined)
                                                ? 'ring-2 ring-offset-2 ring-zinc-950 border-transparent'
                                                : 'border-zinc-200',
                                        ]"
                                        :style="{ backgroundColor: preset.value || '#f4f4f5' }"
                                        :title="preset.name"
                                    >
                                        <span v-if="preset.value === null" class="text-xs text-zinc-500">∅</span>
                                        <Check
                                            v-else-if="hasBatchColorSelected && batchColor === (preset.value ?? undefined)"
                                            class="w-3.5 h-3.5 text-white"
                                        />
                                    </button>
                                </div>
                                <div class="flex gap-2 items-center mt-3">
                                    <div class="relative flex-1">
                                        <Input
                                            v-model="batchColor"
                                            type="text"
                                            :placeholder="t('tags.hex_placeholder')"
                                            class="h-9.5 pl-3 pr-2 text-xs font-mono bg-zinc-50 border-zinc-200 rounded-lg placeholder-zinc-450 text-zinc-800"
                                            :disabled="isBatchLoading"
                                            @input="handleBatchColorInput"
                                        />
                                    </div>
                                    <div
                                        v-if="hasBatchColorSelected && batchColor"
                                        class="w-8 h-8 rounded-full border border-zinc-200 shadow-sm shrink-0"
                                        :style="{ backgroundColor: batchColor }"
                                    ></div>
                                </div>
                                <Button
                                    @click="handleBatchSaveColor"
                                    :disabled="!hasBatchColorSelected || isBatchLoading"
                                    class="w-full mt-2 bg-zinc-900 hover:bg-zinc-800 text-white h-9 rounded-lg font-bold text-xs cursor-pointer shadow-sm transition-colors duration-200"
                                >
                                    <Loader2 v-if="isBatchLoading" class="w-4 h-4 mr-1.5 animate-spin" />
                                    {{ t("tags.batch_apply_color_btn") }}
                                </Button>
                            </div>

                            <!-- Batch Actions -->
                            <div class="border-t border-zinc-100 pt-4 space-y-3">
                                <Label class="text-xs font-semibold text-zinc-700 uppercase tracking-wider block">{{
                                    t("tags.batch_actions")
                                }}</Label>

                                <div class="flex flex-col gap-2">
                                    <template v-if="activeTab === 'active'">
                                        <Button
                                            @click="handleBatchIgnore"
                                            variant="outline"
                                            :disabled="isBatchLoading"
                                            class="w-full text-xs font-bold border-zinc-200 hover:bg-zinc-50 text-zinc-700 h-9 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                        >
                                            <Ban class="w-4 h-4 text-zinc-500" />
                                            {{ t("tags.ignore_selected") }}
                                        </Button>
                                    </template>
                                    <template v-else-if="activeTab === 'candidate'">
                                        <Button
                                            @click="handleBatchPromote"
                                            :disabled="isBatchLoading"
                                            class="w-full text-xs font-bold bg-emerald-600 hover:bg-emerald-50 text-white h-9 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                        >
                                            <Check class="w-4 h-4" />
                                            {{ t("tags.approve_selected") }}
                                        </Button>
                                        <Button
                                            @click="handleBatchIgnore"
                                            variant="outline"
                                            :disabled="isBatchLoading"
                                            class="w-full text-xs font-bold border-zinc-200 hover:bg-zinc-50 text-zinc-700 h-9 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                        >
                                            <Ban class="w-4 h-4 text-zinc-500" />
                                            {{ t("tags.ignore_selected") }}
                                        </Button>
                                    </template>
                                    <template v-else-if="activeTab === 'ignored'">
                                        <Button
                                            @click="handleBatchRestore"
                                            :disabled="isBatchLoading"
                                            class="w-full text-xs font-bold bg-zinc-900 hover:bg-zinc-800 text-white h-9 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                        >
                                            <RotateCcw class="w-4 h-4" />
                                            {{ t("tags.restore_selected") }}
                                        </Button>
                                    </template>

                                    <Button
                                        @click="handleBatchDelete"
                                        variant="outline"
                                        :disabled="isBatchLoading"
                                        class="w-full text-xs font-bold border-red-200 text-red-650 hover:bg-red-50/50 hover:text-red-750 h-9 rounded-lg flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                                    >
                                        <Trash2 class="w-4 h-4" />
                                        {{ t("tags.delete_selected") }}
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </template>

                    <!-- SINGLE INSPECTOR TEMPLATE -->
                    <template v-else-if="activeInspectorTag">
                        <!-- Inspector Header -->
                        <div class="px-6 py-4 border-b border-zinc-150 bg-[#fbfbfb] flex items-center justify-between shrink-0 h-11">
                            <div class="flex items-center gap-2">
                                <span class="text-xs font-bold text-zinc-500 uppercase tracking-wider">{{
                                    t("tags.inspector_title")
                                }}</span>
                                <span
                                    class="text-[10px] font-bold bg-zinc-100 text-zinc-700 border border-zinc-200 rounded-md px-2 py-0.5 tracking-wider uppercase font-mono"
                                >
                                    {{ activeInspectorTag.status }}
                                </span>
                            </div>
                            <button
                                @click="
                                    selectedTag = null;
                                    checkedTagIds = [];
                                    showSidebar = false;
                                "
                                class="p-1 hover:bg-zinc-100 rounded-lg text-zinc-400 hover:text-zinc-650 transition-colors cursor-pointer"
                            >
                                <X class="w-4 h-4" />
                            </button>
                        </div>

                        <!-- Inspector Content -->
                        <div class="flex-1 overflow-y-auto p-6 space-y-6 bg-white">
                            <div class="bg-zinc-50/30 border border-zinc-100 rounded-xl p-4.5 flex items-center gap-3 justify-center">
                                <div
                                    class="inline-flex items-center gap-1.5 px-4.5 py-1.5 rounded-full text-base font-bold border shadow-sm"
                                    :style="getTagBadgeStyle(activeInspectorTag.color)"
                                >
                                    <span class="opacity-60 font-normal">#</span>
                                    <span>{{ activeInspectorTag.name }}</span>
                                </div>
                            </div>

                            <div class="grid grid-cols-2 gap-4">
                                <div class="border border-zinc-200/80 rounded-xl p-3 bg-zinc-50/30">
                                    <span class="text-xs text-zinc-500 font-bold block uppercase tracking-wider">{{
                                        t("tags.post_links")
                                    }}</span>
                                    <div class="flex items-center gap-1.5 mt-1 font-mono font-bold text-zinc-900 text-base">
                                        <FileText class="w-4 h-4 text-zinc-400" />
                                        {{ activeInspectorTag.post_count }}
                                    </div>
                                </div>
                                <div class="border border-zinc-200/80 rounded-xl p-3 bg-zinc-50/30">
                                    <span class="text-xs text-zinc-500 font-bold block uppercase tracking-wider">{{
                                        t("tags.media_links")
                                    }}</span>
                                    <div class="flex items-center gap-1.5 mt-1 font-mono font-bold text-zinc-900 text-base">
                                        <Layers class="w-4 h-4 text-zinc-400" />
                                        {{ activeInspectorTag.media_count }}
                                    </div>
                                </div>
                            </div>

                            <div class="space-y-2">
                                <Label for="inspector-rename" class="text-xs font-semibold text-zinc-700 uppercase tracking-wider">{{
                                    t("tags.rename_label")
                                }}</Label>
                                <Input
                                    id="inspector-rename"
                                    v-model="editName"
                                    :placeholder="t('tags.rename_placeholder')"
                                    class="bg-zinc-50/50 border-zinc-200 h-9.5 text-sm rounded-lg placeholder-zinc-450 focus:ring-1 focus:ring-zinc-950 transition-all duration-200 text-zinc-800"
                                    :disabled="tagStore.isUpdating"
                                />
                            </div>

                            <div class="space-y-2.5">
                                <Label class="text-xs font-semibold text-zinc-700 uppercase tracking-wider">{{
                                    t("tags.accent_color")
                                }}</Label>
                                <div class="flex flex-wrap gap-2">
                                    <button
                                        v-for="preset in colorPresets"
                                        :key="preset.name"
                                        type="button"
                                        @click="editColor = preset.value || undefined"
                                        class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-200 hover:scale-110 cursor-pointer"
                                        :class="[
                                            editColor === (preset.value ?? undefined)
                                                ? 'ring-2 ring-offset-2 ring-zinc-950 border-transparent'
                                                : 'border-zinc-200',
                                        ]"
                                        :style="{ backgroundColor: preset.value || '#f4f4f5' }"
                                        :title="preset.name"
                                    >
                                        <span v-if="preset.value === null" class="text-xs text-zinc-500">∅</span>
                                        <Check v-else-if="editColor === (preset.value ?? undefined)" class="w-3.5 h-3.5 text-white" />
                                    </button>
                                </div>
                                <div class="flex gap-2 items-center mt-3">
                                    <div class="relative flex-1">
                                        <Input
                                            v-model="editColor"
                                            type="text"
                                            :placeholder="t('tags.hex_placeholder')"
                                            class="h-9.5 pl-3 pr-2 text-xs font-mono bg-zinc-50 border-zinc-200 rounded-lg placeholder-zinc-450 text-zinc-800"
                                            :disabled="tagStore.isUpdating"
                                            @input="handleColorInput"
                                        />
                                    </div>
                                    <div
                                        v-if="editColor"
                                        class="w-8 h-8 rounded-full border border-zinc-200 shadow-sm shrink-0"
                                        :style="{ backgroundColor: editColor }"
                                    ></div>
                                </div>
                            </div>

                            <!-- Action Sections: Separated Set as Alias and Merge Tags -->
                            <div v-if="activeInspectorTag.status === 'ACTIVE'" class="border-t border-zinc-150 pt-5 space-y-4">
                                <!-- Block 1: Set as Alias -->
                                <div class="p-4 bg-indigo-50/20 rounded-2xl border border-indigo-500/10 flex items-start gap-3">
                                    <GitMerge class="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                                    <div class="flex-1 space-y-2.5">
                                        <div>
                                            <p class="text-xs font-bold text-indigo-950 mb-0.5">{{ t("tags.alias_card_title") }}</p>
                                            <p class="text-[11px] text-indigo-750/90 leading-relaxed">
                                                {{ t("tags.alias_card_description", { name: activeInspectorTag.name }) }}
                                            </p>
                                        </div>

                                        <!-- Case 1: Tag has no child aliases, so it can be set as an alias -->
                                        <div
                                            v-if="!activeInspectorTag.aliases || activeInspectorTag.aliases.length === 0"
                                            class="space-y-2"
                                        >
                                            <Select v-model="aliasTargetId">
                                                <SelectTrigger
                                                    class="w-full bg-white border border-zinc-200 rounded-lg h-8 text-xs text-zinc-700 font-medium cursor-pointer"
                                                >
                                                    <SelectValue :placeholder="t('tags.alias_card_placeholder')" />
                                                </SelectTrigger>
                                                <SelectContent class="bg-white max-h-48 border-zinc-200 rounded-lg shadow-xl">
                                                    <SelectItem
                                                        v-for="option in mergeOptions"
                                                        :key="option.id"
                                                        :value="option.id"
                                                        class="text-xs cursor-pointer rounded"
                                                    >
                                                        # {{ option.name }}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <Button
                                                @click="handleMergeTags(true)"
                                                :disabled="!aliasTargetId || tagStore.isMerging"
                                                class="w-full text-xs font-bold bg-indigo-650 hover:bg-indigo-700 text-white rounded-lg h-8 transition-colors cursor-pointer"
                                            >
                                                <Loader2 v-if="tagStore.isMerging" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                                {{ t("tags.alias_card_btn") }}
                                            </Button>
                                        </div>

                                        <!-- Case 2: Tag has child aliases, disable alias function to maintain flatness -->
                                        <div v-else class="p-2.5 bg-zinc-50 border border-zinc-200 rounded-lg flex items-start gap-2">
                                            <Info class="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
                                            <p class="text-[10px] text-zinc-650 leading-normal font-medium">
                                                {{ t("tags.alias_card_disabled_tip") }}
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <!-- Block 2: Merge Tags -->
                                <div class="p-4 bg-red-50/10 rounded-2xl border border-red-200/40 flex items-start gap-3">
                                    <Trash2 class="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                                    <div class="flex-1 space-y-2.5">
                                        <div>
                                            <p class="text-xs font-bold text-red-950 mb-0.5">{{ t("tags.merge_card_title") }}</p>
                                            <p class="text-[11px] text-red-750/90 leading-relaxed">
                                                {{ t("tags.merge_card_description", { name: activeInspectorTag.name }) }}
                                            </p>
                                        </div>
                                        <div class="space-y-2">
                                            <Select v-model="mergeTargetId">
                                                <SelectTrigger
                                                    class="w-full bg-white border border-zinc-200 rounded-lg h-8 text-xs text-zinc-700 font-medium cursor-pointer"
                                                >
                                                    <SelectValue :placeholder="t('tags.merge_card_placeholder')" />
                                                </SelectTrigger>
                                                <SelectContent class="bg-white max-h-48 border-zinc-200 rounded-lg shadow-xl">
                                                    <SelectItem
                                                        v-for="option in mergeOptions"
                                                        :key="option.id"
                                                        :value="option.id"
                                                        class="text-xs cursor-pointer rounded"
                                                    >
                                                        # {{ option.name }}
                                                    </SelectItem>
                                                </SelectContent>
                                            </Select>
                                            <Button
                                                @click="handleMergeTags(false)"
                                                :disabled="!mergeTargetId || tagStore.isMerging"
                                                variant="outline"
                                                class="w-full text-xs font-bold border-red-200 text-red-650 hover:bg-red-50 hover:text-red-750 rounded-lg h-8 transition-colors cursor-pointer"
                                            >
                                                <Loader2 v-if="tagStore.isMerging" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                                {{ t("tags.merge_card_btn") }}
                                            </Button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Inspector Footer: Sticky actions footer -->
                        <div class="p-4 bg-zinc-50 border-t border-zinc-150 flex gap-2 shrink-0">
                            <Button
                                @click="handleSaveInspectorChanges"
                                class="flex-1 bg-zinc-900 hover:bg-zinc-800 text-white h-9.5 rounded-lg font-bold text-xs cursor-pointer shadow-sm transition-colors duration-205"
                                :disabled="!editName.trim() || tagStore.isUpdating"
                            >
                                <Loader2 v-if="tagStore.isUpdating" class="w-4 h-4 mr-1.5 animate-spin" />
                                {{ t("tags.save_changes") }}
                            </Button>

                            <Button
                                v-slot:default
                                v-if="activeInspectorTag.status === 'ACTIVE' || activeInspectorTag.status === 'CANDIDATE'"
                                type="button"
                                variant="outline"
                                class="border-zinc-200 hover:bg-zinc-100 cursor-pointer h-9.5 text-zinc-700 font-semibold px-3 shrink-0"
                                @click="handleIgnoreTag(activeInspectorTag)"
                                :title="t('tags.ignore')"
                            >
                                <Ban class="w-4 h-4 text-zinc-500" />
                            </Button>
                            <Button
                                v-slot:default
                                v-else-if="activeInspectorTag.status === 'IGNORED'"
                                type="button"
                                variant="outline"
                                class="border-zinc-200 hover:bg-emerald-50 hover:text-emerald-700 cursor-pointer h-9.5 text-zinc-700 font-semibold px-3 shrink-0"
                                @click="handleRestoreTag(activeInspectorTag)"
                                :title="t('tags.restore')"
                            >
                                <RotateCcw class="w-4 h-4" />
                            </Button>

                            <Button
                                type="button"
                                variant="outline"
                                class="border-red-205 text-red-600 hover:bg-red-50 hover:text-red-750 cursor-pointer h-9.5 text-xs font-semibold px-3 shrink-0"
                                @click="handleDeleteTag(activeInspectorTag.id)"
                                :title="t('tags.delete')"
                            >
                                <Trash2 class="w-4 h-4" />
                            </Button>
                        </div>
                    </template>
                </div>
            </transition>
        </div>

        <!-- DIALOG: CREATE TAG -->
        <Dialog v-model:open="isCreateOpen">
            <DialogContent class="sm:max-w-md bg-white rounded-2xl shadow-xl border border-zinc-200 select-none">
                <DialogHeader class="space-y-1">
                    <DialogTitle class="text-sm font-bold text-zinc-900">{{ t("tags.create_title") }}</DialogTitle>
                    <DialogDescription class="text-xs text-zinc-500">{{ t("tags.create_description") }}</DialogDescription>
                </DialogHeader>

                <form @submit.prevent="handleCreateTag" class="space-y-5 py-2">
                    <div class="space-y-2">
                        <Label for="tag-name" class="text-xs font-bold text-zinc-700 uppercase tracking-wider">{{
                            t("tags.name_label")
                        }}</Label>
                        <Input
                            id="tag-name"
                            v-model="newTagName"
                            :placeholder="t('tags.name_placeholder')"
                            :disabled="tagStore.isCreating"
                            class="bg-zinc-50 border-zinc-200 rounded-lg focus:ring-1 focus:ring-zinc-950 w-full text-sm h-9.5 placeholder-zinc-450 text-zinc-800"
                            autofocus
                        />
                    </div>

                    <!-- Accent Color Picker -->
                    <div class="space-y-3">
                        <Label class="text-xs font-bold text-zinc-700 uppercase tracking-wider">{{ t("tags.color_label") }}</Label>
                        <div class="flex flex-wrap gap-2">
                            <button
                                v-for="preset in colorPresets"
                                :key="preset.name"
                                type="button"
                                @click="newTagColor = preset.value || undefined"
                                class="w-8 h-8 rounded-full border flex items-center justify-center transition-all duration-200 hover:scale-110 cursor-pointer"
                                :class="[
                                    newTagColor === (preset.value ?? undefined)
                                        ? 'ring-2 ring-offset-2 ring-zinc-950 border-transparent'
                                        : 'border-zinc-200',
                                ]"
                                :style="{ backgroundColor: preset.value || '#f4f4f5' }"
                                :title="preset.name"
                            >
                                <span v-if="preset.value === null" class="text-xs text-zinc-500">∅</span>
                                <Check v-else-if="newTagColor === (preset.value ?? undefined)" class="w-3.5 h-3.5 text-white" />
                            </button>
                        </div>
                        <div class="flex gap-2 items-center mt-2">
                            <div class="relative flex-1">
                                <Input
                                    v-model="newTagColor"
                                    type="text"
                                    :placeholder="t('tags.color_placeholder')"
                                    class="h-9.5 pl-3 pr-2 text-xs font-mono bg-zinc-50 border-zinc-200 rounded-lg placeholder-zinc-450 text-zinc-800"
                                    :disabled="tagStore.isCreating"
                                    @input="handleNewColorInput"
                                />
                            </div>
                            <div
                                v-if="newTagColor"
                                class="w-8 h-8 rounded-full border border-zinc-200 shadow-sm shrink-0"
                                :style="{ backgroundColor: newTagColor }"
                            ></div>
                        </div>
                    </div>

                    <DialogFooter class="pt-3 flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            :disabled="tagStore.isCreating"
                            @click="isCreateOpen = false"
                            class="rounded-lg border-zinc-200 hover:bg-[#fafafa] cursor-pointer h-9.5 text-xs font-semibold"
                        >
                            {{ t("tags.cancel") }}
                        </Button>
                        <Button
                            type="submit"
                            class="bg-zinc-900 hover:bg-zinc-800 text-white rounded-lg cursor-pointer h-9.5 text-xs font-bold px-4 transition-colors"
                            :disabled="!newTagName.trim() || tagStore.isCreating"
                        >
                            <Loader2 v-if="tagStore.isCreating" class="animate-spin mr-1.5 w-3.5 h-3.5" />
                            {{ t("tags.create_btn") }}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    </div>
</template>

<style scoped>
.animate-fade-in {
    animation: fadeIn 0.15s ease-out forwards;
}

.animate-slide-up {
    animation: slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

@keyframes fadeIn {
    from {
        opacity: 0;
        transform: translateY(2px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

@keyframes slideUp {
    from {
        opacity: 0;
        transform: translate(-50%, 12px);
    }
    to {
        opacity: 1;
        transform: translate(-50%, 0);
    }
}

/* Side-panel transitions */
.side-panel-enter-active,
.side-panel-leave-active {
    transition:
        transform 0.25s cubic-bezier(0.16, 1, 0.3, 1),
        opacity 0.25s ease;
}
.side-panel-enter-from,
.side-panel-leave-to {
    transform: translateX(100%);
    opacity: 0;
}
.side-panel-enter-to,
.side-panel-leave-from {
    transform: translateX(0);
    opacity: 1;
}
</style>
