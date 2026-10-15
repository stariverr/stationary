import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { env } from "@/global/env";
import { AiConfigurationError, AiProviderError } from "../errors";

/**
 * Provider base URLs are entered by users and requested by the server, so they must not reach
 * the server's own network (databases, cluster services, cloud metadata). Self-hosted deployments
 * that run models next to the server opt in with AI_ALLOW_PRIVATE_NETWORK=true.
 *
 * 198.18.0.0/15 (benchmarking) is deliberately allowed: proxies such as Clash and Surge answer
 * every DNS query with fake addresses from it.
 *
 * Addresses are checked right before each request. A host that changes its DNS answer between
 * the check and the connection could still slip through; redirects are refused for the same reason.
 */
const PRIVATE_RANGES: Array<[string, number, "ipv4" | "ipv6"]> = [
    ["0.0.0.0", 8, "ipv4"], // "this" network
    ["10.0.0.0", 8, "ipv4"],
    ["100.64.0.0", 10, "ipv4"], // carrier-grade NAT
    ["127.0.0.0", 8, "ipv4"],
    ["169.254.0.0", 16, "ipv4"], // link-local, cloud metadata
    ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["224.0.0.0", 4, "ipv4"], // multicast
    ["240.0.0.0", 4, "ipv4"], // reserved, broadcast
    ["::", 128, "ipv6"],
    ["::1", 128, "ipv6"],
    ["fc00::", 7, "ipv6"], // unique local
    ["fe80::", 10, "ipv6"], // link-local
    ["ff00::", 8, "ipv6"], // multicast
];

const privateNetwork = new BlockList();
for (const [address, prefix, family] of PRIVATE_RANGES) privateNetwork.addSubnet(address, prefix, family);

/** Whether an IP address lies in a private, loopback, link-local or otherwise non-public range (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    return privateNetwork.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Throws AiConfigurationError unless `url` is an http(s) URL whose host resolves only to public
 * addresses. A host that does not resolve is reported as a transient provider error.
 */
export async function assertPublicEndpoint(url: string, allowPrivate = env.AI_ALLOW_PRIVATE_NETWORK): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new AiConfigurationError("Provider URL is invalid.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new AiConfigurationError("Provider URL must use http or https.");
    }
    if (allowPrivate) return;

    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    let addresses: string[];
    if (isIP(host)) {
        addresses = [host];
    } else {
        try {
            addresses = (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
        } catch {
            throw new AiProviderError("TRANSIENT", `Provider host ${host} could not be resolved.`);
        }
    }
    if (addresses.some(isPrivateAddress)) {
        throw new AiConfigurationError(
            `Provider host ${host} resolves to a private network address. Set AI_ALLOW_PRIVATE_NETWORK=true to allow self-hosted endpoints.`,
        );
    }
}

/** fetch for every provider request: checks the destination and refuses redirects. */
export async function guardedFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    await assertPublicEndpoint(url);
    return globalThis.fetch(input, { ...init, redirect: "error" });
}
