import { describe, expect, test } from "bun:test";

const gridComponents = ["app/components/PostGrid.vue", "app/components/MediaGrid.vue"];

const readComponent = (componentPath: string) => Bun.file(componentPath).text();

describe("responsive toolbar controls", () => {
    test("uses a polished compact mobile top bar on grid screens", async () => {
        for (const componentPath of gridComponents) {
            const component = await readComponent(componentPath);

            expect(component).toContain(
                'class="sticky top-0 z-30 h-15 sm:h-14 border-b border-gray-100/80 flex items-center gap-2 px-3 sm:px-6',
            );
            expect(component).toContain("bg-white/98 backdrop-blur-md supports-backdrop-filter:bg-white/98");
            expect(component).toContain("h-9 w-9 rounded-full");
            expect(component).toContain("h-9 rounded-full");
        }
    });

    test("hides layout switcher shells on narrow screens", async () => {
        for (const componentPath of gridComponents) {
            const component = await readComponent(componentPath);
            const match = component.match(/<!-- Layout Switchers[\s\S]*?<div class="([^"]+)"/);

            expect(match).not.toBeNull();
            expect(match?.[1] ?? "").toContain("hidden sm:flex");
        }
    });
});
