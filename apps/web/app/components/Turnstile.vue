<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";

const props = defineProps<{
    modelValue: string;
}>();

const emit = defineEmits<{
    (e: "update:modelValue", value: string): void;
}>();

const config = useRuntimeConfig();
const turnstileSiteKey = config.public.turnstileSiteKey;

const containerRef = ref<HTMLElement | null>(null);
const turnstileReady = ref(false);
let turnstileWidgetId: string | null = null;

const renderWidget = () => {
    if (!containerRef.value) return;

    turnstileReady.value = false;
    containerRef.value.innerHTML = "";
    const target = document.createElement("div");
    containerRef.value.appendChild(target);

    if ((window as any).turnstile) {
        try {
            turnstileWidgetId = (window as any).turnstile.render(target, {
                sitekey: turnstileSiteKey,
                callback: (token: string) => {
                    emit("update:modelValue", token);
                },
                "error-callback": () => {
                    emit("update:modelValue", "");
                },
                "expired-callback": () => {
                    emit("update:modelValue", "");
                }
            });
            
            // Allow a short duration for iframe to render, preventing CLS
            setTimeout(() => {
                turnstileReady.value = true;
            }, 600);
        } catch (e) {
            console.error("Turnstile render error:", e);
            turnstileReady.value = true; // Fallback to avoid hiding UI
        }
    }
};

const reset = () => {
    turnstileReady.value = false;
    emit("update:modelValue", "");
    renderWidget();
};

onMounted(() => {
    // 1. Define onload callback globally for the script
    (window as any).onloadTurnstileCallback = () => {
        renderWidget();
    };

    // 2. Load script exactly once
    const existingScript = document.getElementById("turnstile-script");
    if (!existingScript && !(window as any).turnstile) {
        const script = document.createElement("script");
        script.id = "turnstile-script";
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback&render=explicit";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
    } else {
        if ((window as any).turnstile) {
            renderWidget();
        } else {
            // Script tag is already appended but Turnstile is still loading, chain the onload event
            const oldCallback = (window as any).onloadTurnstileCallback;
            (window as any).onloadTurnstileCallback = () => {
                if (oldCallback) oldCallback();
                renderWidget();
            };
        }
    }
});

onUnmounted(() => {
    if ((window as any).turnstile && turnstileWidgetId !== null) {
        try {
            (window as any).turnstile.remove(turnstileWidgetId);
        } catch (e) {
            console.error("Turnstile unmount error:", e);
        }
    }
});

// Expose reset method to parent forms
defineExpose({
    reset
});
</script>

<template>
    <div class="flex justify-center my-3 relative min-h-[65px] w-full items-center">
        <!-- Skeleton Loader -->
        <div 
            v-if="!turnstileReady" 
            class="absolute w-[300px] h-[65px] bg-gray-50 border border-gray-200/60 rounded-xl flex items-center justify-center animate-pulse z-10"
        >
            <div class="flex items-center gap-2.5">
                <div class="w-2 h-2 bg-emerald-500 rounded-full animate-ping"></div>
                <span class="text-xs text-gray-400 font-medium">Checking security...</span>
            </div>
        </div>
        
        <!-- Turnstile Container -->
        <div 
            ref="containerRef" 
            class="w-[300px] h-[65px] transition-opacity duration-300"
            :class="{ 'opacity-0': !turnstileReady, 'opacity-100': turnstileReady }"
        ></div>
    </div>
</template>
