<script setup lang="ts">
import { ChevronLeft } from "@lucide/vue";

definePageMeta({
    layout: false,
});
</script>

<template>
    <div class="min-h-screen bg-gray-50 text-gray-900 py-12 px-4 sm:px-6 lg:px-8 font-sans">
        <div class="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
            <!-- Header -->
            <div class="p-8 border-b border-gray-100 flex items-center justify-between">
                <NuxtLink to="/login" class="flex items-center gap-2 text-sm text-gray-500 hover:text-emerald-600 transition-colors duration-200">
                    <ChevronLeft class="w-4 h-4" />
                    Back to Login
                </NuxtLink>
                <span class="text-xs text-gray-400 font-medium">Last Updated: July 2026</span>
            </div>

            <!-- Content -->
            <div class="p-8 sm:p-10 prose prose-emerald max-w-none">
                <div class="flex items-center gap-3 mb-6">
                    <img src="/logo.svg" alt="Stationary Logo" class="w-10 h-10" />
                    <h1 class="text-3xl font-extrabold text-gray-900 m-0">Terms of Service</h1>
                </div>

                <p class="text-lg text-gray-600 leading-relaxed mb-8">
                    Welcome to Stationary. These Terms of Service ("Terms") govern your access to and use of Stationary's website, services, and applications.
                </p>

                <hr class="border-gray-100 my-8" />

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">1. Acceptance of Terms</h2>
                    <p class="text-gray-600 leading-relaxed">
                        By registering for or using our services, you agree to be bound by these Terms and our Privacy Policy. If you do not agree to these terms, please do not use our services.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">2. Account Registration & Security</h2>
                    <p class="text-gray-600 leading-relaxed mb-4">
                        To access certain features of the service, you must create an account. You agree to:
                    </p>
                    <ul class="list-disc pl-5 text-gray-600 space-y-2 mb-4">
                        <li>Provide accurate, current, and complete information.</li>
                        <li>Keep your password secure and confidential.</li>
                        <li>Notify us immediately of any unauthorized use of your account.</li>
                    </ul>
                    <p class="text-gray-600 leading-relaxed">
                        You are responsible for all activities that occur under your account.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">3. User Conduct & Acceptable Use</h2>
                    <p class="text-gray-600 leading-relaxed">
                        You agree not to use the service to post, transmit, or share content that is unlawful, harmful, threatening, abusive, harassing, defamatory, vulgar, obscene, or invasive of another's privacy.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">4. Intellectual Property</h2>
                    <p class="text-gray-600 leading-relaxed">
                        All materials, content, logos, designs, and software associated with Stationary are protected by intellectual property laws and belong exclusively to Stationary and its licensors.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">5. Termination</h2>
                    <p class="text-gray-600 leading-relaxed">
                        We reserve the right to suspend or terminate your account and access to the service at our sole discretion, without notice, for conduct that we believe violates these Terms or is harmful to other users or our business interests.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">6. Disclaimer of Warranties</h2>
                    <p class="text-gray-600 leading-relaxed">
                        Stationary is provided "as is" and "as available" without any warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement.
                    </p>
                </section>
            </div>
            
            <!-- Footer -->
            <div class="px-8 py-6 bg-gray-50 border-t border-gray-100 text-center">
                <p class="text-xs text-gray-400">
                    &copy; 2026 Stationary. All rights reserved.
                </p>
            </div>
        </div>
    </div>
</template>
