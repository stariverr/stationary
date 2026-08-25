import { describe, expect, test } from "bun:test";
import { deleteAuthor } from "@/features/author/delete-author";
import { deletePost, restorePost, trashPost } from "@/features/post/lifecycle";
import { deleteMedia, restoreMedia, trashMedia } from "@/features/media/lifecycle";
import { deleteLibrary } from "@/features/library/delete-library";
import { deleteTag } from "@/features/tag/tag-service";

describe("delete use case contracts", () => {
    test("author feature owns author deletion", () => {
        expect(typeof deleteAuthor).toBe("function");
        expect(typeof deleteTag).toBe("function");
    });

    test("post lifecycle owns post deletion and recycle actions", () => {
        expect(typeof deletePost).toBe("function");
        expect(typeof trashPost).toBe("function");
        expect(typeof restorePost).toBe("function");
    });

    test("media lifecycle owns media deletion and recycle actions", () => {
        expect(typeof deleteMedia).toBe("function");
        expect(typeof trashMedia).toBe("function");
        expect(typeof restoreMedia).toBe("function");
    });

    test("library feature owns library deletion", () => {
        expect(typeof deleteLibrary).toBe("function");
    });
});
