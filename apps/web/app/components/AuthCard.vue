<script setup lang="ts">
import { ref, computed, watch } from "vue";
import { authClient } from "@/lib/auth-client";
import { Mail, Lock, User, Eye, EyeOff } from "@lucide/vue";
import { toast } from "vue-sonner";

const props = defineProps<{
    mode: "login" | "register";
}>();

const config = useRuntimeConfig();
const router = useRouter();
const { t } = useI18n();

// Mode state
const currentMode = ref(props.mode);

// Watch prop updates to sync mode state (e.g. when back/forward page navigation occurs)
watch(
    () => props.mode,
    (newMode) => {
        currentMode.value = newMode;
    },
);

// Inputs
const email = ref("");
const password = ref("");
const showPassword = ref(false);
const loading = ref(false);

// Captcha state
const turnstileToken = ref("");
const turnstileRef = ref<any>(null);

// Reset captcha when toggling tabs
watch(currentMode, () => {
    turnstileToken.value = "";
    turnstileRef.value?.reset();
});

// Tab Switcher
const setMode = (newMode: "login" | "register") => {
    if (currentMode.value !== newMode) {
        currentMode.value = newMode;
        navigateTo(newMode === "login" ? "/login" : "/register", { replace: true });
    }
};

// Social Sign-Ins
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

const signUpPasswordStrength = computed(() => getPasswordStrength(password.value));

// Handle Sign In

// Handle Sign In
const handleSignIn = async () => {
    if (!email.value || !password.value) {
        toast.error(t("auth.toast_enter_credentials"));
        return;
    }
    if (!turnstileToken.value) {
        toast.error(t("auth.toast_complete_captcha"));
        return;
    }
    loading.value = true;
    try {
        const { data, error } = await authClient.signIn.email({
            email: email.value,
            password: password.value,
            fetchOptions: {
                headers: {
                    "x-captcha-response": turnstileToken.value,
                },
            },
        });
        if (error) {
            if (error.code === "EMAIL_NOT_VERIFIED") {
                toast.info(t("auth.toast_email_not_verified"));
                await authClient.emailOtp.sendVerificationOtp({
                    email: email.value,
                    type: "email-verification",
                });
                navigateTo(`/verify-email?email=${encodeURIComponent(email.value)}`);
            } else {
                toast.error(error.message || t("auth.toast_invalid_credentials"));
                turnstileRef.value?.reset();
            }
        } else {
            toast.success(t("auth.toast_welcome_back"));
            navigateTo("/");
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
        turnstileRef.value?.reset();
    } finally {
        loading.value = false;
    }
};

// Handle Sign Up
const handleSignUp = async () => {
    if (!email.value || !password.value) {
        toast.error(t("auth.toast_fill_fields"));
        return;
    }
    if (password.value.length < 8 || password.value.length > 20) {
        toast.error(t("auth.strength_length_error"));
        return;
    }
    if (!/^[\x20-\x7E]*$/.test(password.value)) {
        toast.error(t("auth.strength_ascii_only"));
        return;
    }
    if (!turnstileToken.value) {
        toast.error(t("auth.toast_complete_captcha"));
        return;
    }
    loading.value = true;
    try {
        const { data, error } = await authClient.signUp.email({
            email: email.value,
            password: password.value,
            name: email.value.split("@")[0] || "User",
            fetchOptions: {
                headers: {
                    "x-captcha-response": turnstileToken.value,
                },
            },
        });
        if (error) {
            toast.error(error.message || t("auth.toast_registration_failed"));
            turnstileRef.value?.reset();
        } else {
            toast.success(t("auth.toast_registration_success"));
            navigateTo(`/verify-email?email=${encodeURIComponent(email.value)}`);
        }
    } catch (err: any) {
        toast.error(err.message || t("auth.toast_unexpected_error"));
        turnstileRef.value?.reset();
    } finally {
        loading.value = false;
    }
};

const handleSubmit = async () => {
    if (currentMode.value === "login") {
        await handleSignIn();
    } else {
        await handleSignUp();
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
            <div class="p-6 flex flex-col items-center">
                <!-- Branding -->
                <div class="relative group mb-3">
                    <div
                        class="absolute -inset-0.5 bg-linear-to-r from-emerald-500 to-teal-500 rounded-full blur opacity-30 group-hover:opacity-50 transition duration-1000"
                    ></div>
                    <img
                        src="/logo.svg"
                        alt="Stationary Logo"
                        class="relative w-12 h-12 transform group-hover:scale-105 transition-all duration-300"
                    />
                </div>

                <div class="w-full">
                    <h1 class="text-xl font-bold text-gray-900 text-center mb-3 tracking-tight">
                        {{ currentMode === "login" ? $t("auth.welcome_back") : $t("auth.create_account") }}
                    </h1>

                    <p class="text-xs text-gray-400 text-center mb-2 font-bold uppercase tracking-wider">
                        {{ currentMode === "login" ? $t("auth.social_sign_in") : $t("auth.social_sign_up") }}
                    </p>

                    <!-- Social Buttons (Primary/Top OAuth Flow) -->
                    <div class="flex justify-center gap-3 mb-4">
                        <button
                            type="button"
                            @click="loginWithGithub"
                            class="flex items-center justify-center gap-2 px-5 py-2 bg-white text-gray-700 border border-gray-200 rounded-xl text-xs font-semibold hover:bg-gray-50 hover:border-gray-300 hover:shadow-xs transition-all duration-200 active:scale-[0.98] cursor-pointer"
                        >
                            <img src="/auth-providers/github.svg" class="w-4 h-4" alt="GitHub" />
                            <span>{{ $t("auth.github") }}</span>
                        </button>
                        <button
                            type="button"
                            @click="loginWithGoogle"
                            class="flex items-center justify-center gap-2 px-5 py-2 bg-white text-gray-700 border border-gray-200 rounded-xl text-xs font-semibold hover:bg-gray-50 hover:border-gray-300 hover:shadow-xs transition-all duration-200 active:scale-[0.98] cursor-pointer"
                        >
                            <img src="/auth-providers/google.svg" class="w-4 h-4" alt="Google" />
                            <span>{{ $t("auth.google") }}</span>
                        </button>
                    </div>

                    <!-- Divider -->
                    <div class="relative mb-4">
                        <div class="absolute inset-0 flex items-center">
                            <div class="w-full border-t border-gray-100"></div>
                        </div>
                        <div class="relative flex justify-center text-xs uppercase">
                            <span class="bg-white px-3 text-gray-400 font-semibold tracking-wider">{{ $t("auth.or_divider") }}</span>
                        </div>
                    </div>

                    <!-- Tab Switcher (Segmented Control) -->
                    <div class="relative bg-gray-100/80 p-0.5 rounded-xl flex mb-4">
                        <button
                            type="button"
                            @click="setMode('login')"
                            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 cursor-pointer"
                            :class="currentMode === 'login' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'"
                        >
                            {{ $t("auth.set_mode_login") }}
                        </button>
                        <button
                            type="button"
                            @click="setMode('register')"
                            class="flex-1 py-1.5 text-xs font-bold rounded-lg transition-all duration-200 cursor-pointer"
                            :class="
                                currentMode === 'register' ? 'bg-white text-emerald-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                            "
                        >
                            {{ $t("auth.set_mode_register") }}
                        </button>
                    </div>

                    <!-- Form -->
                    <form @submit.prevent="handleSubmit" class="space-y-3.5">
                        <!-- Email Address -->
                        <div class="space-y-1">
                            <label class="text-xs font-bold text-gray-500 uppercase tracking-wider">{{ $t("auth.email_label") }}</label>
                            <div class="relative">
                                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
                                    <Mail class="w-4 h-4" />
                                </span>
                                <input
                                    v-model="email"
                                    type="email"
                                    :placeholder="$t('auth.email_placeholder')"
                                    required
                                    class="w-full pl-9 pr-3 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                                />
                            </div>
                        </div>

                        <!-- Password -->
                        <div class="space-y-1">
                            <div class="flex justify-between items-center">
                                <label class="text-xs font-bold text-gray-500 uppercase tracking-wider">{{
                                    $t("auth.password_label")
                                }}</label>
                                <NuxtLink
                                    v-if="currentMode === 'login'"
                                    to="/forgot-password"
                                    class="text-xs font-bold text-emerald-600 hover:text-emerald-700 hover:underline"
                                >
                                    {{ $t("auth.forgot_password") }}
                                </NuxtLink>
                                <span
                                    v-else-if="currentMode === 'register' && password"
                                    :class="signUpPasswordStrength.textColor"
                                    class="text-xs font-bold"
                                >
                                    {{ $t("auth.password_strength", { strength: $t(`auth.strength_${signUpPasswordStrength.textKey}`) }) }}
                                </span>
                            </div>
                            <div class="relative">
                                <span class="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-400">
                                    <Lock class="w-4 h-4" />
                                </span>
                                <input
                                    v-model="password"
                                    :type="showPassword ? 'text' : 'password'"
                                    :placeholder="$t('auth.password_placeholder')"
                                    required
                                    class="w-full pl-9 pr-9 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
                                />
                                <button
                                    type="button"
                                    @click="showPassword = !showPassword"
                                    class="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 cursor-pointer"
                                >
                                    <Eye v-if="!showPassword" class="w-4 h-4" />
                                    <EyeOff v-else class="w-4 h-4" />
                                </button>
                                <!-- Inline 2px color indicator for password strength on registration -->
                                <div
                                    v-if="currentMode === 'register' && password"
                                    class="absolute bottom-0 left-0 right-0 h-0.5 rounded-b-xl transition-all duration-300"
                                    :class="signUpPasswordStrength.color"
                                ></div>
                            </div>
                            <!-- Validation warning text (only visible when validation fails) -->
                            <p
                                v-if="currentMode === 'register' && password && !/^[\x20-\x7E]*$/.test(password)"
                                class="text-[11px] text-red-500 mt-1"
                            >
                                {{ $t("auth.strength_ascii_only") }}
                            </p>
                            <p
                                v-else-if="currentMode === 'register' && password && (password.length < 8 || password.length > 20)"
                                class="text-[11px] text-red-500 mt-1"
                            >
                                {{ $t("auth.strength_length_error") }}
                            </p>
                        </div>

                        <!-- Turnstile -->
                        <div class="flex justify-center pt-1">
                            <Turnstile ref="turnstileRef" v-model="turnstileToken" />
                        </div>

                        <!-- Action Button -->
                        <button
                            type="submit"
                            :disabled="loading"
                            class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-sm font-semibold shadow-md shadow-emerald-600/10 hover:shadow-emerald-600/20 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
                        >
                            <span v-if="loading">
                                {{ currentMode === "login" ? $t("auth.sign_in_loading") : $t("auth.sign_up_loading") }}
                            </span>
                            <span v-else>
                                {{ currentMode === "login" ? $t("auth.sign_in_btn") : $t("auth.sign_up_btn") }}
                            </span>
                        </button>
                    </form>
                </div>
            </div>

            <!-- Policy Footer -->
            <div class="p-4 bg-gray-50/50 border-t border-gray-100 text-center rounded-b-2xl">
                <p class="text-xs text-gray-500 leading-relaxed">
                    {{ $t("auth.policy_prefix") }}
                    <NuxtLink to="/terms" class="text-gray-900 font-semibold hover:underline">
                        {{ $t("auth.terms_of_service") }}
                    </NuxtLink>
                    {{ $t("auth.policy_and") }}
                    <NuxtLink to="/privacy" class="text-gray-900 font-semibold hover:underline">
                        {{ $t("auth.privacy_policy") }}
                    </NuxtLink>
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
