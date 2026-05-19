import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

describe("library item movement UI", () => {
    test("submits the move-items action payload expected by the backend", () => {
        const store = readFileSync("app/stores/library.ts", "utf8");

        expect(store).toContain("moveItems");
        expect(store).toContain("'/library/move-items'");
        expect(store).toContain("post_ids: payload.postIds");
        expect(store).toContain("media_ids: payload.mediaIds");
        expect(store).toContain("target_library_id: payload.targetLibraryId");
        expect(store).toContain("response?.message || 'Failed to move items'");
    });

    test("uses the bottom batch bar instead of a move dialog", () => {
        const postGrid = readFileSync("app/components/PostGrid.vue", "utf8");
        const mediaGrid = readFileSync("app/components/MediaGrid.vue", "utf8");

        expect(existsSync("app/components/MoveItemsDialog.vue")).toBe(false);
        expect(postGrid).toContain("<MoveItemsBar");
        expect(mediaGrid).toContain("<MoveItemsBar");
    });

    test("does not expose a persistent Select Page control in grid headers", () => {
        const postGrid = readFileSync("app/components/PostGrid.vue", "utf8");
        const mediaGrid = readFileSync("app/components/MediaGrid.vue", "utf8");

        expect(postGrid).not.toContain("Select Page");
        expect(mediaGrid).not.toContain("Select Page");
    });

    test("keeps item checkboxes contextual until a selection exists", () => {
        const postCard = readFileSync("app/components/PostCard.vue", "utf8");
        const mediaCard = readFileSync("app/components/MediaCard.vue", "utf8");

        expect(postCard).toContain("showCheckbox || isHovered");
        expect(mediaCard).toContain("showCheckbox || isHovered");
    });
});
