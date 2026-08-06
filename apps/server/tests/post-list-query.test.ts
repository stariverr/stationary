import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const resolveSrc = (relativePath: string) => join(import.meta.dir, "..", relativePath);

describe("post list query", () => {
    test("filters by the post library foreign key", async () => {
        const source = await Bun.file(resolveSrc("src/api/post.ts")).text();

        expect(source).toContain("eq(Post.library_id, library_id)");
        expect(source).not.toContain("eq(Library.id, library_id)");
    });
});
