<script setup lang="ts">
import { ref, onMounted, computed, nextTick } from "vue";
import { authClient } from "@/lib/auth-client";
import { Mail, Lock, Eye, EyeOff, ArrowLeft } from "@lucide/vue";
import { toast } from "vue-sonner";

definePageMeta({
    layout: false,
});

const config = useRuntimeConfig();
const { t } = useI18n();
const turnstileSiteKey = config.public.turnstileSiteKey;

type Step = "request" | "reset";
const currentStep = ref<Step>("request");

// Inputs
const email = ref("");
const otp = ref("");
const newPassword = ref("");
const showPassword = ref(false);
const loading = ref(false);

// Captcha state
const turnstileToken = ref("");
const turnstileRequestRef = ref<any>(null);
const turnstileResetRef = ref<any>(null);

// Password strength calculation
const getPasswordStrength = (pwd: string) => {
    if (!pwd) return { score: 0, textKey: "none", color: "bg-gray-200", textColor: "text-gray-400" };

    const hasValidChars = /^[\x20-\x7E]*$/.test(pwd);
    if (!hasValidChars) {
        return { score: 0, textKey: "invalid", color: "bg-red-500", textColor: "text-red-500" };
    }

    if (pwd.length < 8) {
        return { score: 1, textKey: "too_short", color: "bg-red-500", textColor: "text-red-500" };
    }
    if (pwd.length > 20) {
        return { score: 1, textKey: "too_long", color: "bg-red-500", textColor: "text-red-500" };
    }

    let score = 1;
    if (/[a-z]/.test(pwd)) score++;
    if (/[A-Z]/.test(pwd)) score++;
    if (/[0-9]/.test(pwd)) score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;

    const finalScore = Math.min(score, 4);

    let textKey = "weak";
    let color = "bg-red-500";
    let textColor = "text-red-500";
    if (finalScore === 2) {
        textKey = "fair";
        color = "bg-amber-500";
        textColor = "text-amber-500";
    } else if (finalScore === 3) {
        textKey = "good";
        color = "bg-emerald-500";
        textColor = "text-emerald-500";
    } else if (finalScore === 4) {
        textKey = "strong";
        color = "bg-teal-500";
        textColor = "text-teal-500";
    }

    return { score: finalScore, textKey, color, textColor };
};

const resetPasswordStrength = computed(() => getPasswordStrength(newPassword.value));

const setStep = (step: Step) => {
    currentStep.value = step;
    turnstileToken.value = "";
};

// Request Password Reset OTP
const handleRequestReset = async () => {
    if (!email.value) {
        toast.error(t("auth.toast_enter_email"));
        return;
    }
    if (!turnstileToken.value) {
        toast.error(t("auth.toast_complete_captcha"));
        return;
    }
    loading.value = true;
    try {
        const { data, error } = await authClient.emailOtp.sendVerificationOtp({
            email: email.value,
            type: "forget-password",
            fetchOptions: {
                headers: {
                    "x-captcha-response": turnstileToken.value,
                },
            },
        });
        if (error) {
            toast.error(error.message || t("auth.toast_unexpected_error"));
            turnstileRequestRef.value?.reset();
        } else {
            toast.success(t("auth.toast_code_sent"));
            setStep("reset");
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
        turnstileRequestRef.value?.reset();
    } finally {
        loading.value = false;
    }
};

// Reset Password using OTP
const handleResetPassword = async () => {
    if (!otp.value || !newPassword.value) {
        toast.error(t("auth.toast_fill_code_password"));
        return;
    }
    if (newPassword.value.length < 8 || newPassword.value.length > 20) {
        toast.error(t("auth.strength_length_error"));
        return;
    }
    if (!/^[\x20-\x7E]*$/.test(newPassword.value)) {
        toast.error(t("auth.strength_ascii_only"));
        return;
    }
    if (!turnstileToken.value) {
        toast.error(t("auth.toast_complete_captcha"));
        return;
    }
    loading.value = true;
    try {
        const { data, error } = await authClient.emailOtp.resetPassword({
            email: email.value,
            otp: otp.value,
            password: newPassword.value,
            fetchOptions: {
                headers: {
                    "x-captcha-response": turnstileToken.value,
                },
            },
        });
        if (error) {
            toast.error(error.message || t("auth.toast_unexpected_error"));
            turnstileResetRef.value?.reset();
        } else {
            toast.success(t("auth.toast_reset_success"));
            navigateTo("/login");
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
        turnstileResetRef.value?.reset();
    } finally {
        loading.value = false;
    }
};
</script>

<template>
    <div class="min-h-dvh flex items-center justify-center bg-radial from-[#e8f5e9] via-[#f9fafb] to-[#f3f4f6] p-4 font-sans antialiased">
        <div
            class="relative w-full max-w-md bg-white rounded-2xl shadow-2xl border border-white/50 flex flex-col transition-all duration-300"
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

                <!-- Step 1: Request OTP -->
                <div v-if="currentStep === 'request'" class="w-full">
                    <h1 class="text-2xl font-bold text-gray-900 text-center mb-1">{{ $t("auth.reset_password_title") }}</h1>
                    <p class="text-sm text-gray-500 text-center mb-6">{{ $t("auth.reset_password_desc") }}</p>

                    <form @submit.prevent="handleRequestReset" class="space-y-4">
                        <div class="space-y-1">
                            <label class="text-xs font-semibold text-gray-600 uppercase tracking-wider">{{ $t("auth.email_label") }}</label>
                            <div class="relative">
                                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
                                    <Mail class="w-5 h-5" />
                                </span>
                                <input
                                    v-model="email"
                                    type="email"
                                    :placeholder="$t('auth.email_placeholder')"
                                    required
                                    class="w-full pl-10 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                                />
                            </div>
                        </div>

                        <!-- Turnstile -->
                        <Turnstile ref="turnstileRequestRef" v-model="turnstileToken" />

                        <button
                            type="submit"
                            :disabled="loading"
                            class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium shadow-lg shadow-emerald-600/20 transition-all duration-200 active:scale-[0.99] disabled:opacity-50"
                        >
                            <span v-if="loading">{{ $t("auth.sending_btn") }}</span>
                            <span v-else>{{ $t("auth.send_reset_code_btn") }}</span>
                        </button>
                    </form>

                    <NuxtLink
                        to="/login"
                        class="w-full text-center text-xs text-gray-500 hover:text-gray-700 hover:underline mt-6 flex items-center justify-center gap-1"
                    >
                        <ArrowLeft class="w-3.5 h-3.5" />
                        {{ $t("auth.back_to_login") }}
                    </NuxtLink>
                </div>

                <!-- Step 2: Reset Password with OTP -->
                <div v-else class="w-full">
                    <h1 class="text-2xl font-bold text-gray-900 text-center mb-1">{{ $t("auth.set_new_password_title") }}</h1>
                    <p class="text-sm text-gray-500 text-center mb-6">{{ $t("auth.set_new_password_desc") }}</p>

                    <form @submit.prevent="handleResetPassword" class="space-y-4">
                        <div class="space-y-1">
                            <label class="text-xs font-semibold text-gray-600 uppercase tracking-wider block text-center mb-1">{{
                                $t("auth.verification_code_label")
                            }}</label>
                            <input
                                v-model="otp"
                                type="text"
                                maxLength="6"
                                placeholder="123456"
                                required
                                class="w-full text-center tracking-[0.5em] text-xl font-mono py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                            />
                        </div>

                        <div class="space-y-1">
                            <label class="text-xs font-semibold text-gray-600 uppercase tracking-wider">{{
                                $t("auth.new_password_label")
                            }}</label>
                            <div class="relative">
                                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
                                    <Lock class="w-5 h-5" />
                                </span>
                                <input
                                    v-model="newPassword"
                                    :type="showPassword ? 'text' : 'password'"
                                    :placeholder="$t('auth.password_placeholder')"
                                    required
                                    class="w-full pl-10 pr-10 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                                />
                                <button
                                    type="button"
                                    @click="showPassword = !showPassword"
                                    class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
                                >
                                    <Eye v-if="!showPassword" class="w-5 h-5" />
                                    <EyeOff v-else class="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <!-- Password Strength Meter -->
                        <div v-if="newPassword" class="space-y-1.5 mt-1">
                            <div class="flex justify-between items-center text-xs">
                                <span class="text-gray-500">{{
                                    $t("auth.password_strength", { strength: $t(`auth.strength_${resetPasswordStrength.textKey}`) })
                                }}</span>
                            </div>
                            <div class="grid grid-cols-4 gap-1">
                                <div
                                    v-for="i in 4"
                                    :key="i"
                                    class="h-1.5 rounded-full transition-all duration-300"
                                    :class="i <= resetPasswordStrength.score ? resetPasswordStrength.color : 'bg-gray-200'"
                                ></div>
                            </div>
                            <p v-if="!/^[\x20-\x7E]*$/.test(newPassword)" class="text-[11px] text-red-500">
                                {{ $t("auth.strength_ascii_only") }}
                            </p>
                            <p v-else-if="newPassword.length < 8 || newPassword.length > 20" class="text-[11px] text-red-500">
                                {{ $t("auth.strength_length_error") }}
                            </p>
                        </div>

                        <!-- Turnstile -->
                        <Turnstile ref="turnstileResetRef" v-model="turnstileToken" />

                        <button
                            type="submit"
                            :disabled="loading"
                            class="w-full py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium shadow-lg shadow-emerald-600/20 transition-all duration-200 active:scale-[0.99] disabled:opacity-50"
                        >
                            <span v-if="loading">{{ $t("auth.resetting_btn") }}</span>
                            <span v-else>{{ $t("auth.update_password_btn") }}</span>
                        </button>
                    </form>

                    <button
                        @click="setStep('request')"
                        class="w-full text-center text-xs text-gray-500 hover:text-gray-700 hover:underline mt-6 flex items-center justify-center gap-1 cursor-pointer"
                    >
                        <ArrowLeft class="w-3.5 h-3.5" />
                        {{ $t("auth.back_to_step_1") }}
                    </button>
                </div>
            </div>

            <!-- Policy Footer -->
            <div class="p-6 bg-gray-50/50 border-t border-gray-100 text-center rounded-b-2xl">
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
