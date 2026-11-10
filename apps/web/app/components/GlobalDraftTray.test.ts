import { describe, expect, test } from "bun:test";

describe("merge files dialog", () => {
    test("uses an explicit wide desktop max width and viewport-safe height", async () => {
        const component = await Bun.file("app/components/DraftMergeDialog.vue").text();

        expect(component).toContain("sm:max-w-5xl");
        expect(component).toContain("max-h-[calc(100dvh-1rem)]");
        expect(component).toContain('class="flex w-[calc(100%-1rem)]');
        expect(component).not.toContain('class="max-w-2xl max-h-[85vh]');
    });

    test("lists the files in a table on wide containers and in cards on narrow ones", async () => {
        const dialog = await Bun.file("app/components/DraftMergeDialog.vue").text();
        const table = await Bun.file("app/components/DraftFilesTable.vue").text();

        expect(dialog).toContain('<DraftFilesTable :media-type="mergeType" :files="mergeFiles" />');
        expect(table).toContain('class="@container"');
        expect(table).toContain("@2xl:block");
        expect(table).toContain("@2xl:hidden");
    });

    test("disables commit while the composition is invalid", async () => {
        const component = await Bun.file("app/components/DraftMergeDialog.vue").text();

        expect(component).toContain(':disabled="!mergeTitle.trim() || Boolean(mergeCompositionError)"');
        expect(component).toContain('role="alert"');
    });
});
