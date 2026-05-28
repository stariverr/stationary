import tailwindcss from "@tailwindcss/vite";

export default defineNuxtConfig({
    srcDir: 'app',
    compatibilityDate: '2026-05-18',
    ssr: true,
    devtools: { enabled: false },
    devServer: {
        port: 4000
    },
    modules: [
        "@pinia/nuxt",
        "shadcn-nuxt",
        "@nuxtjs/i18n"
    ],
    i18n: {
        locales: [
            { code: 'en-US', file: 'en-US.json', name: 'English (US)' },
            { code: 'en-GB', file: 'en-GB.json', name: 'English (UK)' },
            { code: 'zh-Hans', file: 'zh-Hans.json', name: '简体中文' },
            { code: 'zh-Hant', file: 'zh-Hant.json', name: '繁體中文' },
            { code: 'ja-JP', file: 'ja-JP.json', name: '日本語' },
            { code: 'de-DE', file: 'de-DE.json', name: 'Deutsch' },
            { code: 'de-CH', file: 'de-CH.json', name: 'Deutsch (Schweiz)' },
            { code: 'fr-FR', file: 'fr-FR.json', name: 'Français' },
            { code: 'ko-KR', file: 'ko-KR.json', name: '한국어' },
            { code: 'pt-PT', file: 'pt-PT.json', name: 'Português' },
            { code: 'es-ES', file: 'es-ES.json', name: 'Español' },
            { code: 'nl-NL', file: 'nl-NL.json', name: 'Nederlands' }
        ],
        defaultLocale: 'en-US',
        langDir: '../i18n/locales',
        strategy: 'no_prefix'
    },
    vite: {
        plugins: [
            tailwindcss()
        ],
        resolve: {
            tsconfigPaths: true
        },
        devtools: {
            enabled: true
        },
        optimizeDeps: {
            include: [
                '@vueuse/core',
                '@tanstack/vue-query',
                '@lucide/vue',
                'swiper/vue',
                '@js-temporal/polyfill',
                'plyr',
            ]
        }
    },
    css: ['@/assets/css/main.css'],
    pinia: {
        storesDirs: ['./app/stores'],
    },
    runtimeConfig: {
        public: {
            apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL || 'http://localhost:8080',
            cdnBaseUrl: process.env.NUXT_PUBLIC_CDN_BASE_URL || 'http://localhost:8080',
            appUrl: process.env.NUXT_PUBLIC_APP_URL || 'http://localhost:4000',
        }
    },
    nitro: {
        preset: 'cloudflare-module'
    },
    shadcn: {
        prefix: '',
        componentDir: '@/components/ui'
    },
})
