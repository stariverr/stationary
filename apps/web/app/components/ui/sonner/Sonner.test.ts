import { describe, expect, test } from "bun:test";

describe("shadcn Sonner setup", () => {
    test("loads vue-sonner styles globally", async () => {
        const css = await Bun.file("app/assets/css/main.css").text();

        expect(css).toContain('@import "vue-sonner/style.css";');
    });

    test("library dialog uses the local shadcn sonner export", async () => {
        const dialog = await Bun.file("app/components/CreateLibraryDialog.vue").text();

        expect(dialog).toContain('from "@/components/ui/sonner"');
        expect(dialog).not.toContain('from "vue-sonner"');
    });
});
