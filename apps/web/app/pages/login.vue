<script setup lang="ts">
import { authClient } from "@/lib/auth-client";
import { GalleryHorizontal, Mail, Astroid } from "@lucide/vue";

definePageMeta({
    layout: false,
});

const config = useRuntimeConfig();

const loginWithGithub = async () => {
    await authClient.signIn.social({
        provider: "github",
        callbackURL: config.public.appUrl as string | undefined,
    });
};

const loginWithGoogle = async () => {
    await authClient.signIn.social({
        provider: "google",
        callbackURL: config.public.appUrl as string | undefined,
    });
};
</script>

<template>
    <div class="min-h-dvh flex items-center justify-center bg-[#f9fafb] p-4 font-sans">
        <div class="w-full max-w-md bg-white rounded-2xl shadow-xl border border-gray-100 overflow-hidden flex flex-col">
            <div class="p-8 flex flex-col items-center text-center">
                <!-- Logo / Icon -->
                <div class="w-16 h-16 bg-black rounded-2xl flex items-center justify-center mb-6 shadow-lg shadow-black/10">
                    <div class="w-8 h-8 bg-white rounded-full"></div>
                </div>

                <h1 class="text-2xl font-bold text-gray-900 mb-2">Welcome Back</h1>
                <p class="text-gray-500 mb-8">Sign in to your account to continue</p>

                <div class="w-full space-y-3">
                    <button
                        @click="loginWithGithub"
                        class="w-full flex items-center justify-center gap-3 px-4 py-3 bg-black text-white rounded-xl font-medium hover:bg-gray-800 transition-all duration-200 active:scale-[0.98]"
                    >
                        <Astroid class="w-5 h-5" />
                        Continue with GitHub
                    </button>

                    <button
                        @click="loginWithGoogle"
                        class="w-full flex items-center justify-center gap-3 px-4 py-3 bg-white text-gray-700 border border-gray-200 rounded-xl font-medium hover:bg-gray-50 transition-all duration-200 active:scale-[0.98]"
                    >
                        <Mail class="w-5 h-5 text-red-500" />
                        Continue with Google
                    </button>
                </div>
            </div>

            <div class="p-6 bg-gray-50 border-t border-gray-100 text-center">
                <p class="text-sm text-gray-500">
                    By continuing, you agree to our
                    <a href="#" class="text-black font-medium hover:underline">Terms</a> and
                    <a href="#" class="text-black font-medium hover:underline">Privacy Policy</a>.
                </p>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Add any specific styles if needed */
</style>
