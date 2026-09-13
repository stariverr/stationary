import { describe, expect, test } from "bun:test";

const gridComponents = ["app/components/PostGrid.vue", "app/components/MediaGrid.vue"];

const readComponent = (componentPath: string) => Bun.file(componentPath).text();

describe("responsive toolbar controls", () => {
    test("uses a polished compact mobile top bar on grid screens", async () => {
        for (const componentPath of gridComponents) {
            const component = await readComponent(componentPath);

            expect(component).toContain(
                'class="z-30 h-14 border-b border-zinc-200/80 flex items-center gap-2 px-4 md:px-6 shrink-0 bg-white"',
            );
            expect(component).toContain("h-8 w-8 rounded-lg");
            expect(component).toContain("h-9 rounded-full");
        }
    });

    test("hides layout switcher shells on narrow screens", async () => {
        const mediaComponent = await readComponent("app/components/MediaGrid.vue");
        const matchMedia = mediaComponent.match(/<!-- Layout Switchers[\s\S]*?<div class="([^"]+)"/);
        expect(matchMedia).not.toBeNull();
        expect(matchMedia?.[1] ?? "").toContain("hidden sm:flex");

        const postComponent = await readComponent("app/components/PostGrid.vue");
        expect(postComponent).toContain("<!-- View Options Dropdown -->");
    });
});
