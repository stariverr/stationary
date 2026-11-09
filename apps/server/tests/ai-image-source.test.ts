import { describe, expect, test } from "bun:test";
import { PreviewSize } from "../src/db/schema";
import { aiSourceHash, selectAiPreview } from "../src/features/ai/image-source";

const row = (size: PreviewSize) => ({ preview: { size } });

describe("AI image source selection", () => {
    test("reads the largest preview, and a smaller one while it is missing", () => {
        const small = row(PreviewSize.SMALL);
        const medium = row(PreviewSize.MEDIUM);
        const large = row(PreviewSize.LARGE);

        expect(selectAiPreview([small, large, medium])).toBe(large);
        expect(selectAiPreview([small, medium])).toBe(medium);
        expect(selectAiPreview([small])).toBe(small);
        expect(selectAiPreview([])).toBeNull();
    });

    test("identifies the source by its content hash, else by the file", () => {
        expect(aiSourceHash({ id: "f", hash: "abc" })).toBe("abc");
        expect(aiSourceHash({ id: "f", hash: null })).toBe("file:f");
    });
});
