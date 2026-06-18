import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("shadcn Sonner setup", () => {
    test("loads vue-sonner styles globally", () => {
        const css = readFileSync("app/assets/css/main.css", "utf8");

        expect(css).toContain('@import "vue-sonner/style.css";');
    });

    test("library dialog uses the local shadcn sonner export", () => {
        const dialog = readFileSync("app/components/CreateLibraryDialog.vue", "utf8");

        expect(dialog).toContain('from "@/components/ui/sonner"');
        expect(dialog).not.toContain('from "vue-sonner"');
    });
});
