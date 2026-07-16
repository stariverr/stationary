<script setup lang="ts">
import { Dialog, DialogContent } from "@/components/ui/dialog";
import CreateMediaForm from "./CreateMediaForm.vue";

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
    (e: "created", media: { id: string; title: string; type: string }): void;
}>();

function handleCreated(media: { id: string; title: string; type: string }) {
    open.value = false;
    emit("created", media);
}
</script>

<template>
    <Dialog v-model:open="open">
        <DialogContent data-create-media-dialog class="sm:max-w-5xl flex flex-col max-h-[calc(100dvh-1rem)] p-0 overflow-hidden">
            <CreateMediaForm mode="standalone" @created="handleCreated" @cancel="open = false" />
        </DialogContent>
    </Dialog>
</template>
