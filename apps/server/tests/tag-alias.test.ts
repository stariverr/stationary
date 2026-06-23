import { describe, expect, test } from "bun:test";
import { sanitizeTagAliases } from "../src/lib/utils/tag_sanitizer";
import { TagCreateBodySchema, TagUpdateBodySchema } from "../src/api/tag";

describe("tag alias sanitization utility", () => {
    test("trims whitespace and ignores empty aliases", () => {
        const result = sanitizeTagAliases("Fashion", ["  ", "Trends  ", ""]);
        expect(result).toEqual(["Trends"]);
    });

    test("deduplicates aliases case-insensitively and preserves first match casing", () => {
        const result = sanitizeTagAliases("Design", ["UI", "ui", "Ui/Ux", "ui/ux"]);
        expect(result).toEqual(["UI", "Ui/Ux"]);
    });

    test("strips hashes and matches against tag name", () => {
        const result = sanitizeTagAliases("AI", ["Intel", "ai", "#AI", "##ai"]);
        expect(result).toEqual(["Intel"]);
    });

    test("excludes aliases matching the tag name itself", () => {
        const result = sanitizeTagAliases("Landing Page", ["landing page", "LP", "landing page  "]);
        expect(result).toEqual(["LP"]);
    });

    test("excludes aliases matching junk words", () => {
        const result = sanitizeTagAliases("Shopping", ["领券", "淘口令", "Pills"]);
        expect(result).toEqual(["Pills"]);
    });
});

describe("tag schema validations", () => {
    test("create tag schema validates correct input", () => {
        const parsed = TagCreateBodySchema.safeParse({
            library_id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
            name: "Landing Page",
        });
        expect(parsed.success).toBe(true);
    });

    test("create tag schema rejects invalid library_id", () => {
        const parsed = TagCreateBodySchema.safeParse({
            library_id: "invalid-uuid",
            name: "Landing Page",
        });
        expect(parsed.success).toBe(false);
    });

    test("update tag schema validates correct input", () => {
        const parsed = TagUpdateBodySchema.safeParse({
            id: "018f3b06-70ce-7b2a-9f60-3ed8f0f7b7b3",
            name: "Promotions",
        });
        expect(parsed.success).toBe(true);
    });

    test("update tag schema rejects invalid tag id", () => {
        const parsed = TagUpdateBodySchema.safeParse({
            id: "invalid-uuid",
        });
        expect(parsed.success).toBe(false);
    });
});
