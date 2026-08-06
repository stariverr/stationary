import { describe, expect, test } from "bun:test";
import { assertUniqueExternalIds, normalizeExternalId } from "../src/lib/utils/media-identity";

describe("Media external identity", () => {
    test("trims stable external IDs at the domain boundary", () => {
        expect(normalizeExternalId("  media-123  ", "media.external_id")).toBe("media-123");
    });

    test("rejects missing and blank identities", () => {
        expect(() => normalizeExternalId(undefined)).toThrow("external_id is required");
        expect(() => normalizeExternalId("   ")).toThrow("external_id must not be empty");
    });

    test("rejects duplicate identities within one scope", () => {
        expect(() => assertUniqueExternalIds(["a", "b", "a"], "media in post p1")).toThrow(
            "Duplicate media in post p1 external_id: a",
        );
    });
});
