import tailwindcss from "@tailwindcss/vite";

const backendApiBaseUrl = process.env.NUXT_API_BASE_URL || "http://127.0.0.1:9400/api";

export default defineNuxtConfig({
    srcDir: "app",
    app: {
        head: {
            title: "Stationary - Media Asset Management",
            link: [{ rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
        },
    },
    future: {
        compatibilityVersion: 5,
    },
    experimental: {
        // compatibilityVersion 5 drops Nitro's built-in auto-imports, but @nuxtjs/i18n's server runtime
        // still imports useRuntimeConfig from "#imports".
        nitroAutoImports: true,
    },
    compatibilityDate: "2026-10-27",
    ssr: true,
    vue: {
        compilerOptions: {
            isCustomElement: (tag) => tag.startsWith("media-"),
        },
    },
    devtools: { enabled: false },
    devServer: {
        port: 4000,
    },
    modules: ["@pinia/nuxt", "shadcn-nuxt", "@nuxtjs/i18n"],
    i18n: {
        locales: [
            { code: "en-US", file: "en-US.json", name: "English (US)" },
            { code: "en-GB", file: "en-GB.json", name: "English (UK)" },
            { code: "zh-Hans", file: "zh-Hans.json", name: "简体中文" },
            { code: "zh-Hant", file: "zh-Hant.json", name: "繁體中文" },
            { code: "ja-JP", file: "ja-JP.json", name: "日本語" },
            { code: "de-DE", file: "de-DE.json", name: "Deutsch" },
            { code: "de-CH", file: "de-CH.json", name: "Deutsch (Schweiz)" },
            { code: "fr-FR", file: "fr-FR.json", name: "Français" },
            { code: "ko-KR", file: "ko-KR.json", name: "한국어" },
            { code: "pt-PT", file: "pt-PT.json", name: "Português" },
            { code: "es-ES", file: "es-ES.json", name: "Español" },
            { code: "nl-NL", file: "nl-NL.json", name: "Nederlands" },
        ],
        defaultLocale: "en-US",
        langDir: "../i18n/locales",
        strategy: "no_prefix",
    },
    vite: {
        plugins: [tailwindcss()],
        optimizeDeps: {
            include: ["@vueuse/core", "@tanstack/vue-query", "@lucide/vue", "swiper/vue", "@js-temporal/polyfill", "vidstack"],
        },
    },
    css: ["@/assets/css/main.css"],
    pinia: {
        storesDirs: ["./app/stores"],
    },
    // Dev only: the browser talks to a single origin, like the production gateway (Caddy / ingress).
    routeRules:
        process.env.NODE_ENV === "development"
            ? {
                  "/api/**": { proxy: `${backendApiBaseUrl}/**` },
              }
            : {},
    runtimeConfig: {
        // Server-side only: direct backend base URL, no browser involved.
        apiBaseUrl: backendApiBaseUrl,
        public: {
            // Browser-facing API base URL (same-origin gateway).
            apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL || "/api",
            cdnBaseUrl: process.env.NUXT_PUBLIC_CDN_BASE_URL || "http://localhost:9400",
            appUrl: process.env.NUXT_PUBLIC_APP_URL || "http://localhost:4000",
            turnstileSiteKey: process.env.NUXT_PUBLIC_TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
        },
    },
    shadcn: {
        prefix: "",
        componentDir: "@/components/ui",
    },
});
