// Code uses the global `Temporal`. Runtimes without a native implementation load the polyfill
// as a separate chunk; the rest never download it.
export default defineNuxtPlugin({
    name: "temporal",
    enforce: "pre",
    async setup() {
        if (typeof globalThis.Temporal !== "undefined") return;
        const { Temporal } = await import("@js-temporal/polyfill");
        globalThis.Temporal = Temporal as unknown as typeof globalThis.Temporal;
    },
});
