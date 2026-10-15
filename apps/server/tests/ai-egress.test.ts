import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { env } from "@/global/env";
import { AiConfigurationError } from "@/features/ai/errors";
import { assertAllowedEndpoint, guardedFetch } from "@/features/ai/providers/egress";

const METADATA_AND_LAN = ["169.254.0.0/16", "10.0.0.0/8", "127.0.0.0/8", "::1/128", "fe80::/10", "fc00::/7"];

describe("AI provider egress guard", () => {
    const originalBlocked = env.AI_BLOCKED_CIDRS;
    beforeEach(() => {
        env.AI_BLOCKED_CIDRS = [];
    });
    afterEach(() => {
        env.AI_BLOCKED_CIDRS = originalBlocked;
    });

    it("allows every destination when nothing is blocked", async () => {
        for (const url of ["http://127.0.0.1:6379", "http://localhost:11434/v1", "http://169.254.169.254/latest"]) {
            await expect(assertAllowedEndpoint(url)).resolves.toBeUndefined();
        }
    });

    it("still rejects invalid URLs and non-http schemes", async () => {
        await expect(assertAllowedEndpoint("not a url")).rejects.toBeInstanceOf(AiConfigurationError);
        await expect(assertAllowedEndpoint("ftp://8.8.8.8/")).rejects.toBeInstanceOf(AiConfigurationError);
    });

    it("rejects destinations inside a blocked CIDR, mapped IPv6 addresses included", async () => {
        for (const url of [
            "http://127.0.0.1:6379",
            "http://localhost:11434/v1",
            "http://10.1.2.3/v1",
            "http://[::1]/v1",
            "http://[fe80::1]/v1",
            "http://[fd00::1]/v1",
            "http://[::ffff:169.254.169.254]/latest/meta-data",
        ]) {
            await expect(assertAllowedEndpoint(url, METADATA_AND_LAN)).rejects.toBeInstanceOf(AiConfigurationError);
        }
    });

    it("allows destinations outside every blocked CIDR", async () => {
        for (const url of ["https://8.8.8.8/v1", "https://[2606:4700:4700::1111]/v1", "http://192.168.1.1/v1"]) {
            await expect(assertAllowedEndpoint(url, METADATA_AND_LAN)).resolves.toBeUndefined();
        }
    });

    it("never sends a request to a blocked destination", async () => {
        env.AI_BLOCKED_CIDRS = METADATA_AND_LAN;
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

    it("refuses redirects only while blocking is on", async () => {
        const originalFetch = globalThis.fetch;
        const redirects: Array<RequestInit["redirect"]> = [];
        globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
            redirects.push(init?.redirect);
            return new Response("{}");
        }) as unknown as typeof fetch;
        try {
            await guardedFetch("https://8.8.8.8/v1");
            env.AI_BLOCKED_CIDRS = METADATA_AND_LAN;
            await guardedFetch("https://8.8.8.8/v1");
            expect(redirects).toEqual([undefined, "error"]);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});
