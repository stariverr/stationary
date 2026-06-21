import { describe, expect, test } from "bun:test";

describe("library item movement UI", () => {
    test("submits the move-items action payload expected by the backend", async () => {
        const store = await Bun.file("app/stores/library.ts").text();

        expect(store).toContain("moveItems");
        expect(store).toContain('"/library/move-items"');
        expect(store).toContain("post_ids: payload.postIds");
        expect(store).toContain("media_ids: payload.mediaIds");
        expect(store).toContain("target_library_id: payload.targetLibraryId");
        expect(store).toContain('response?.message || "Failed to move items"');
    });

    test("uses the bottom batch bar instead of a move dialog", async () => {
        const postGrid = await Bun.file("app/components/PostGrid.vue").text();
        const mediaGrid = await Bun.file("app/components/MediaGrid.vue").text();
        const dialogExists = await Bun.file("app/components/MoveItemsDialog.vue").exists();

        expect(dialogExists).toBe(false);
        expect(postGrid).toContain("<MoveItemsBar");
        expect(mediaGrid).toContain("<MoveItemsBar");
    });

    test("does not expose a persistent Select Page control in grid headers", async () => {
        const postGrid = await Bun.file("app/components/PostGrid.vue").text();
        const mediaGrid = await Bun.file("app/components/MediaGrid.vue").text();

        expect(postGrid).not.toContain("Select Page");
        expect(mediaGrid).not.toContain("Select Page");
    });

    test("keeps item checkboxes contextual until a selection exists", async () => {
        const postCard = await Bun.file("app/components/PostCard.vue").text();
        const mediaCard = await Bun.file("app/components/MediaCard.vue").text();

        expect(postCard).toContain("showCheckbox || isHovered");
        expect(mediaCard).toContain("showCheckbox || isHovered");
    });
});
