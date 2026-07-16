import { describe, expect, test } from "bun:test";

describe("merge tracks dialog", () => {
    test("uses an explicit wide desktop max width and viewport-safe height", async () => {
        const component = await Bun.file("app/components/GlobalDraftTray.vue").text();

        expect(component).toContain("sm:max-w-5xl");
        expect(component).toContain("max-h-[calc(100dvh-1rem)]");
        expect(component).toContain('class="flex w-[calc(100%-1rem)]');
        expect(component).not.toContain('class="max-w-2xl max-h-[85vh]');
    });

    test("uses separate mobile cards and a stable desktop table", async () => {
        const component = await Bun.file("app/components/GlobalDraftTray.vue").text();

        expect(component).toContain("min-w-[900px]");
        expect(component).toContain("lg:block");
        expect(component).toContain("lg:hidden");
        expect(component).toContain("Mobile track cards");
    });

    test("disables commit while the composition is invalid", async () => {
        const component = await Bun.file("app/components/GlobalDraftTray.vue").text();

        expect(component).toContain(':disabled="!mergeTitle.trim() || Boolean(mergeCompositionError)"');
        expect(component).toContain('role="alert"');
    });
});
