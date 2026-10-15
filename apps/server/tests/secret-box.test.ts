import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { createSecretBox } from "@/lib/utils/secret-box";

const key = randomBytes(32).toString("base64");

describe("secret box", () => {
    it("round-trips secrets without storing plaintext", () => {
        const box = createSecretBox(key);
        const ciphertext = box.encrypt("sk-live-secret");
        expect(ciphertext.startsWith("v1:")).toBe(true);
        expect(ciphertext).not.toContain("sk-live-secret");
        expect(box.encrypt("sk-live-secret")).not.toBe(ciphertext);
        expect(box.decrypt(ciphertext)).toBe("sk-live-secret");
    });

    it("rejects tampered ciphertext and foreign keys", () => {
        const box = createSecretBox(key);
        const ciphertext = box.encrypt("secret");
        const bytes = Buffer.from(ciphertext.slice(3), "base64");
        bytes[bytes.length - 1]! ^= 1;
        expect(() => box.decrypt(`v1:${bytes.toString("base64")}`)).toThrow();
        expect(() => createSecretBox(randomBytes(32).toString("base64")).decrypt(ciphertext)).toThrow();
    });

    it("requires a 32-byte key", () => {
        expect(() => createSecretBox(randomBytes(16).toString("base64"))).toThrow();
    });
});
