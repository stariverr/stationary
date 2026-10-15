import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { env } from "@/global/env";
import { AiConfigurationError } from "@/features/ai/errors";
import { assertPublicEndpoint, guardedFetch, isPrivateAddress } from "@/features/ai/providers/egress";

describe("AI provider egress guard", () => {
    // tests/preload.ts lifts the guard for the rest of the suite; these tests need it.
    beforeEach(() => {
        env.AI_ALLOW_PRIVATE_NETWORK = false;
    });
    afterEach(() => {
        env.AI_ALLOW_PRIVATE_NETWORK = true;
    });

    it("classifies private, loopback, link-local and mapped addresses", () => {
        for (const address of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.20.0.5", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
            expect(isPrivateAddress(address)).toBe(true);
        }
        for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
            expect(isPrivateAddress(address)).toBe(false);
        }
    });

    it("rejects private destinations and non-http schemes", async () => {
        for (const url of ["http://127.0.0.1:6379", "http://[::ffff:169.254.169.254]/latest/meta-data", "http://localhost:11434/v1", "ftp://8.8.8.8/"]) {
            await expect(assertPublicEndpoint(url, false)).rejects.toBeInstanceOf(AiConfigurationError);
        }
        await expect(assertPublicEndpoint("https://8.8.8.8/v1", false)).resolves.toBeUndefined();
    });

    it("allows private destinations when self-hosting is enabled", async () => {
        await expect(assertPublicEndpoint("http://localhost:11434/v1", true)).resolves.toBeUndefined();
    });

    it("never sends a request to a private destination", async () => {
        const originalFetch = globalThis.fetch;
        let called = false;
        globalThis.fetch = (async () => {
            called = true;
            return new Response("{}");
        }) as unknown as typeof fetch;
        try {
            await expect(guardedFetch("http://10.0.0.1/v1/models")).rejects.toBeInstanceOf(AiConfigurationError);
            expect(called).toBe(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
