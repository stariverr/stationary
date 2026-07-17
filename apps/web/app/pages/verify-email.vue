<script setup lang="ts">
import { ref, onMounted } from "vue";
import { authClient } from "@/lib/auth-client";
import { ShieldCheck, ArrowLeft, RotateCcw } from "@lucide/vue";
import { toast } from "vue-sonner";

definePageMeta({
    layout: false,
});

const route = useRoute();
const { t } = useI18n();
const verificationEmail = ref((route.query.email as string) || "");

// Inputs
const otpCode = ref("");
const loading = ref(false);
const resendCooldown = ref(0);

// Resend cooldown timer
const startCooldown = () => {
    resendCooldown.value = 60;
    const interval = setInterval(() => {
        if (resendCooldown.value > 0) {
            resendCooldown.value--;
        } else {
            clearInterval(interval);
        }
    }, 1000);
};

onMounted(() => {
    if (verificationEmail.value) {
        startCooldown();
    }
});

// Handlers
const handleVerifyEmail = async () => {
    if (!verificationEmail.value) {
        toast.error(t("auth.toast_no_email"));
        return;
    }
    if (!otpCode.value) {
        toast.error(t("auth.toast_enter_code"));
        return;
    }
    loading.value = true;
    try {
        const { data, error } = await authClient.emailOtp.verifyEmail({
            email: verificationEmail.value,
            otp: otpCode.value,
        });
        if (error) {
            toast.error(error.message || t("auth.toast_unexpected_error"));
        } else {
            toast.success(t("auth.toast_verify_success"));
            navigateTo("/");
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
    } finally {
        loading.value = false;
    }
};

const handleResendOTP = async () => {
    if (!verificationEmail.value) {
        toast.error(t("auth.toast_no_email"));
        return;
    }
    if (resendCooldown.value > 0) return;
    loading.value = true;
    try {
        const { data, error } = await authClient.emailOtp.sendVerificationOtp({
            email: verificationEmail.value,
            type: "email-verification",
        });
        if (error) {
            toast.error(error.message || t("auth.toast_unexpected_error"));
        } else {
            toast.success(t("auth.toast_code_resent"));
            startCooldown();
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
    } finally {
        loading.value = false;
    }
};
</script>

<template>
    <div class="min-h-dvh flex items-center justify-center bg-radial from-[#e8f5e9] via-[#f9fafb] to-[#f3f4f6] p-4 font-sans antialiased">
        <div
            class="relative w-full max-w-md bg-white/80 backdrop-blur-xl rounded-2xl shadow-2xl border border-white/50 overflow-hidden flex flex-col transition-all duration-300"
        >
            <div class="absolute top-4 right-4 z-50">
                <LanguageSwitcher />
            </div>
            <div class="p-8 flex flex-col items-center">
                <!-- Branding -->
                <div class="relative group mb-6">
                    <div
                        class="absolute -inset-0.5 bg-linear-to-r from-emerald-500 to-teal-500 rounded-full blur opacity-30 group-hover:opacity-50 transition duration-1000"
                    ></div>
                    <img
                        src="/logo.svg"
                        alt="Stationary Logo"
                        class="relative w-16 h-16 transform group-hover:scale-105 transition-all duration-300"
                    />
                </div>

                <div class="w-full">
                    <div class="flex flex-col items-center text-center">
                        <div class="w-12 h-12 bg-emerald-50 rounded-full flex items-center justify-center text-emerald-600 mb-4">
                            <ShieldCheck class="w-6 h-6" />
                        </div>
                        <h1 class="text-2xl font-bold text-gray-900 mb-1">{{ $t("auth.verify_email_title") }}</h1>
                        <p class="text-sm text-gray-500 mb-6">
                            {{ $t("auth.verify_email_desc", { email: verificationEmail }) }}
                        </p>
                    </div>

                    <form @submit.prevent="handleVerifyEmail" class="space-y-5">
                        <div class="space-y-1">
                            <label class="text-xs font-semibold text-gray-600 uppercase tracking-wider block text-center mb-2">{{
                                $t("auth.verification_code_label")
                            }}</label>
                            <input
                                v-model="otpCode"
                                type="text"
                                maxLength="6"
                                placeholder="123456"
                                required
                                class="w-full text-center tracking-[0.5em] text-xl font-mono py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                            />
                        </div>

                        <button
                            type="submit"
                            :disabled="loading"
                            class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium shadow-lg shadow-emerald-600/20 transition-all duration-200 active:scale-[0.99] disabled:opacity-50"
                        >
                            <span v-if="loading">{{ $t("auth.verifying_btn") }}</span>
                            <span v-else>{{ $t("auth.confirm_code_btn") }}</span>
                        </button>
                    </form>

                    <div class="mt-6 flex flex-col items-center gap-3">
                        <button
                            @click="handleResendOTP"
                            :disabled="resendCooldown > 0 || loading"
                            class="text-sm text-emerald-600 font-semibold hover:underline disabled:text-gray-400 disabled:no-underline flex items-center gap-2 cursor-pointer"
                        >
                            <RotateCcw class="w-4 h-4" />
                            <span v-if="resendCooldown > 0">{{ $t("auth.resend_code_cooldown", { cooldown: resendCooldown }) }}</span>
                            <span v-else>{{ $t("auth.resend_code_btn") }}</span>
                        </button>

                        <NuxtLink
                            to="/register"
                            class="text-xs text-gray-500 hover:text-gray-700 hover:underline flex items-center gap-1 mt-2"
                        >
                            <ArrowLeft class="w-3.5 h-3.5" />
                            {{ $t("auth.back_to_sign_up") }}
                        </NuxtLink>
                    </div>
                </div>
            </div>

            <!-- Policy Footer -->
            <div class="p-6 bg-gray-50/50 border-t border-gray-100 text-center">
                <p class="text-xs text-gray-500 leading-relaxed">
                    {{ $t("auth.policy_prefix") }}
                    <NuxtLink to="/terms" class="text-gray-900 font-semibold hover:underline">{{ $t("auth.terms_of_service") }}</NuxtLink>
                    {{ $t("auth.policy_and") }}
                    <NuxtLink to="/privacy" class="text-gray-900 font-semibold hover:underline">{{ $t("auth.privacy_policy") }}</NuxtLink>
                    {{ $t("auth.policy_suffix") }}
                </p>
            </div>
        </div>
    </div>
</template>

<style scoped>
.bg-radial {
    background-image: radial-gradient(var(--tw-gradient-stops));
}
</style>
