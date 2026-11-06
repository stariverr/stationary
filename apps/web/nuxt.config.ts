import tailwindcss from "@tailwindcss/vite";

// Video.js elements used by components/MediaVideoPlayer.vue.
const videoJsElements = new Set([
    "video-player",
    "media-container",
    "media-controls",
    "media-controls-group",
    "media-play-button",
    "media-pip-button",
    "media-fullscreen-button",
    "media-time",
    "media-time-slider",
    "media-slider-track",
    "media-slider-buffer",
    "media-slider-fill",
    "media-slider-thumb",
    "media-gesture",
    "media-hotkey",
    "dash-video",
]);

const backendApiBaseUrl = process.env.NUXT_API_BASE_URL || "http://127.0.0.1:9400/api";

export default defineNuxtConfig({
    srcDir: "app",
    app: {
        head: {
            title: "Stationary - Media Asset Management",
            link: [{ rel: "icon", type: "image/svg+xml", href: "/logo.svg" }],
        },
    },
    experimental: {
        // Nuxt 5 drops Nitro's built-in auto-imports, but @nuxtjs/i18n's server runtime
        // still imports useRuntimeConfig from "#imports".
        nitroAutoImports: true,
    },
    compatibilityDate: "2026-10-27",
    ssr: true,
    vue: {
        compilerOptions: {
            isCustomElement: (tag) => videoJsElements.has(tag),
        },
    },
    devtools: { enabled: false },
    devServer: {
        port: 4000,
    },
    modules: ["@pinia/nuxt", "@nuxtjs/i18n"],
    // shadcn-vue components are imported explicitly; keep them out of auto-registration.
    components: [{ path: "~/components", ignore: ["ui/**"] }],
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
        // Module workers, so a worker can import code-split dependencies (libheif in the HEIC decoder).
        worker: { format: "es" },
        optimizeDeps: {
            include: ["@vueuse/core", "@tanstack/vue-query", "@lucide/vue", "swiper/vue", "@js-temporal/polyfill"],
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
});
