import { describe, expect, test } from "bun:test";

const routeSources = {
    library: () => Bun.file("src/api/library.ts").text(),
    media: () => Bun.file("src/api/media.ts").text(),
    post: () => Bun.file("src/api/post.ts").text(),
    user: () => Bun.file("src/api/user.ts").text(),
};

const expectRouteRequiresAuth = (source: string, method: string, path: string) => {
    const escapedPath = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(source).toMatch(new RegExp(`router\\.${method}\\(\\s*["']${escapedPath}["'],\\s*requireAuth`));
};

describe("route authentication", () => {
    test("post routes require auth", async () => {
        const source = await routeSources.post();

        expectRouteRequiresAuth(source, "get", "/list");
        expectRouteRequiresAuth(source, "get", "/detail/:id");
    });

    test("media routes require auth", async () => {
        const source = await routeSources.media();

        expectRouteRequiresAuth(source, "get", "/list");
    });

    test("library routes require auth", async () => {
        const source = await routeSources.library();

        expectRouteRequiresAuth(source, "get", "/list");
        expectRouteRequiresAuth(source, "post", "/create");
        expectRouteRequiresAuth(source, "post", "/update");
        expectRouteRequiresAuth(source, "post", "/delete/:id");
    });

    test("user profile route requires auth", async () => {
        const source = await routeSources.user();

        expect(source).toContain("router.use(\"*\", requireAuth)");
    });
});
