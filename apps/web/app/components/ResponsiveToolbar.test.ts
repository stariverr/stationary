import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const gridComponents = ["app/components/PostGrid.vue", "app/components/MediaGrid.vue"];

const readComponent = (componentPath: string) => readFileSync(componentPath, "utf8");

describe("responsive toolbar controls", () => {
    test("uses a polished compact mobile top bar on grid screens", () => {
        for (const componentPath of gridComponents) {
            const component = readComponent(componentPath);

            expect(component).toContain('class="h-[60px] sm:h-14 border-b border-gray-100/80 flex items-center gap-2 px-3 sm:px-6');
            expect(component).toContain("bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80");
            expect(component).toContain("h-10 w-10 rounded-xl");
            expect(component).toContain("h-10 rounded-2xl");
            expect(component).toContain("shadow-[0_1px_2px_rgba(15,23,42,0.04)]");
        }
    });

    test("hides layout switcher shells on narrow screens", () => {
        for (const componentPath of gridComponents) {
            const component = readComponent(componentPath);
            const match = component.match(/<!-- Layout Switchers[\s\S]*?<div class="([^"]+)"/);

            expect(match).not.toBeNull();
            expect(match?.[1] ?? "").toContain("hidden sm:flex");
        }
    });
});
