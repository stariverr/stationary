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
                    <h1 class="text-3xl font-extrabold text-gray-900 m-0">Privacy Policy</h1>
                </div>

                <p class="text-lg text-gray-600 leading-relaxed mb-8">
                    At Stationary, we value your privacy. This Privacy Policy describes how we collect, use, process, and disclose your personal information when you use our services.
                </p>

                <hr class="border-gray-100 my-8" />

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">1. Information We Collect</h2>
                    <p class="text-gray-600 leading-relaxed mb-4">
                        We collect information to provide better services to our users. This includes:
                    </p>
                    <ul class="list-disc pl-5 text-gray-600 space-y-2">
                        <li><strong>Account Information:</strong> Your name, email address, password, and profile image when you register.</li>
                        <li><strong>OAuth Data:</strong> If you connect using a third-party social provider (GitHub or Google), we receive information authorized by that provider.</li>
                        <li><strong>Usage Information:</strong> Metadata about how you interact with our application, media assets, and search features.</li>
                    </ul>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">2. How We Use Information</h2>
                    <p class="text-gray-600 leading-relaxed mb-4">
                        We use the information we collect to operate, maintain, and improve our services, including to:
                    </p>
                    <ul class="list-disc pl-5 text-gray-600 space-y-2">
                        <li>Authenticate your identity and secure your account.</li>
                        <li>Process and store files and data you submit.</li>
                        <li>Communicate with you (e.g. sending verification codes or support messages).</li>
                        <li>Monitor and analyze usage trends to optimize application performance.</li>
                    </ul>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">3. Information Sharing and Disclosure</h2>
                    <p class="text-gray-600 leading-relaxed">
                        We do not sell, trade, or otherwise transfer your personally identifiable information to outside parties. This does not include trusted third parties who assist us in operating our website, conducting our business, or serving our users (such as our database, storage providers, or email delivery systems), so long as those parties agree to keep this information confidential.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">4. Security of Your Information</h2>
                    <p class="text-gray-600 leading-relaxed">
                        We implement a variety of security measures to maintain the safety of your personal information. These include encrypting sensitive data in transit and at rest, and using secure authentication tokens. However, no method of transmission over the Internet or electronic storage is 100% secure.
                    </p>
                </section>

                <section class="mb-8">
                    <h2 class="text-xl font-bold text-gray-900 mb-4">5. Your Rights and Choices</h2>
                    <p class="text-gray-600 leading-relaxed">
                        You may review, update, or delete your account information at any time by accessing your profile settings or by contacting us. If you request account deletion, we will delete or anonymize your data in accordance with our retention policy.
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
