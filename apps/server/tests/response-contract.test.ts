import { describe, expect, test } from "bun:test";
import { Code } from "../src/lib/code";
import { success } from "../src/lib/response";

const apiSources = [
    "src/api/library.ts",
    "src/api/media.ts",
    "src/api/post.ts",
    "src/api/task.ts",
    "src/api/user.ts",
    "src/lib/auth/middleware.ts",
];

const stripStrings = (source: string) =>
    source
        .replace(/`(?:\\.|[^`\\])*`/gs, "\"\"")
        .replace(/"(?:\\.|[^"\\])*"/gs, "\"\"")
        .replace(/'(?:\\.|[^'\\])*'/gs, "\"\"");

describe("response contract", () => {
    test("success can carry paginated list data inside data", () => {
        expect(success(Code.SUCCESS, { list: ["post-1"], total: 1 })).toEqual({
            success: true,
            code: Code.SUCCESS,
            message: "Success",
            data: {
                list: ["post-1"],
                total: 1,
            },
        });
    });

    test("list response helper is removed", async () => {
        const responseSource = await Bun.file("src/lib/response.ts").text();

        expect(responseSource).not.toMatch(/export\s+function\s+list\b/);
    });

    test("api JSON responses are wrapped with success or error", async () => {
        for (const file of apiSources) {
            const source = stripStrings(await Bun.file(file).text());

            expect(source, file).not.toMatch(/\bc\.json\(\s*\{/);
            expect(source, file).not.toMatch(/\bc\.json\(\s*list\(/);
        }
    });
});
