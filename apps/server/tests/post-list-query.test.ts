import { describe, expect, test } from "bun:test";

describe("post list query", () => {
    test("filters by the post library foreign key", async () => {
        const source = await Bun.file("src/api/post.ts").text();

        expect(source).toContain("eq(Post.library_id, c.req.valid(\"query\").library_id)");
        expect(source).not.toContain("eq(Library.id, c.req.valid(\"query\").library_id)");
    });
});
