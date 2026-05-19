<script setup lang="ts">
import { ref, watch } from "vue";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useLibraryStore } from "@/stores/library";
import { Loader2 } from "@lucide/vue";
import { toast } from "@/components/ui/sonner";

const props = defineProps<{
    open: boolean;
}>();

const emit = defineEmits<{
    "update:open": [value: boolean];
}>();

const libraryStore = useLibraryStore();

const name = ref("");
const description = ref("");
const isCreating = ref(false);

// Reset form when dialog opens/closes
watch(
    () => props.open,
    (newVal) => {
        if (newVal) {
            name.value = "";
            description.value = "";
        }
    },
);

const getCreateLibraryErrorDescription = (e: any) => {
    const backendMessage =
        e?.data?.message ||
        e?.data?.error ||
        e?.response?._data?.message ||
        e?.response?._data?.error;

    if (backendMessage) {
        return backendMessage;
    }

    if (e?.statusCode === 400 || e?.status === 400) {
        return "Please check the workspace name and description, then try again.";
    }

    return "Something went wrong while creating the workspace.";
};

const handleSubmit = async () => {
    if (!name.value.trim()) {
        toast.warning("Workspace name is required", {
            description: "Please enter a name before creating a workspace.",
        });
        return;
    }

    if (isCreating.value) return;

    try {
        isCreating.value = true;
        await libraryStore.createLibrary(
            name.value.trim(),
            description.value.trim(),
        );
        emit("update:open", false);
        toast.success("Workspace created", {
            description: `${name.value.trim()} is now your active workspace.`,
        });
    } catch (e: any) {
        toast.error("Failed to create workspace", {
            description: getCreateLibraryErrorDescription(e),
        });
    } finally {
        isCreating.value = false;
    }
};

const handleOpenChange = (val: boolean) => {
    if (!isCreating.value) {
        emit("update:open", val);
    }
};
</script>

<template>
    <Dialog :open="open" @update:open="handleOpenChange">
        <DialogContent class="sm:max-w-md">
            <DialogHeader>
                <DialogTitle>Create Workspace</DialogTitle>
                <DialogDescription>
                    Create a new workspace to organize your collections
                    separately.
                </DialogDescription>
            </DialogHeader>

            <form @submit.prevent="handleSubmit" class="grid gap-4 py-2">
                <div class="grid gap-2">
                    <Label for="library-name">Name</Label>
                    <Input
                        id="library-name"
                        v-model="name"
                        placeholder="My Workspace"
                        :disabled="isCreating"
                        autofocus
                    />
                </div>

                <div class="grid gap-2">
                    <Label for="library-description">
                        Description
                        <span class="text-muted-foreground font-normal"
                            >(optional)</span
                        >
                    </Label>
                    <Textarea
                        id="library-description"
                        v-model="description"
                        placeholder="A brief description of this workspace..."
                        :disabled="isCreating"
                        class="resize-none"
                        rows="3"
                    />
                </div>

                <DialogFooter class="pt-2">
                    <Button
                        type="button"
                        variant="outline"
                        :disabled="isCreating"
                        @click="handleOpenChange(false)"
                    >
                        Cancel
                    </Button>
                    <Button
                        type="submit"
                        :disabled="!name.trim() || isCreating"
                    >
                        <Loader2 v-if="isCreating" class="animate-spin" />
                        {{ isCreating ? "Creating..." : "Create" }}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
</template>
