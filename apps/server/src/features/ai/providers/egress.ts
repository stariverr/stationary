import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { env } from "@/global/env";
import { AiConfigurationError, AiProviderError } from "../errors";

/**
 * Provider base URLs are entered by users and requested by the server. Everything is allowed
 * unless the operator lists CIDR blocks in AI_BLOCKED_CIDRS (databases, cluster services, cloud
 * metadata, ...); then the host is resolved and every address is checked against them.
 *
 * Addresses are checked right before each request. A host that changes its DNS answer between
 * the check and the connection could still slip through; redirects are refused for the same reason.
 */
function createBlockList(cidrs: readonly string[]): BlockList {
    const blockList = new BlockList();
    for (const cidr of cidrs) {
        const [address = "", prefix = ""] = cidr.split("/");
        blockList.addSubnet(address, Number(prefix), isIP(address) === 4 ? "ipv4" : "ipv6");
    }
    return blockList;
}

/**
 * Throws AiConfigurationError unless `url` is an http(s) URL whose host resolves to no blocked
 * address. A host that does not resolve is reported as a transient provider error.
 */
export async function assertAllowedEndpoint(url: string, blockedCidrs: readonly string[] = env.AI_BLOCKED_CIDRS): Promise<void> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new AiConfigurationError("Provider URL is invalid.");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new AiConfigurationError("Provider URL must use http or https.");
    }
    if (blockedCidrs.length === 0) return;

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
    const blockList = createBlockList(blockedCidrs);
    const blocked = addresses.find((address) => blockList.check(address, isIP(address) === 4 ? "ipv4" : "ipv6"));
    if (blocked) {
        throw new AiConfigurationError(`Provider host ${host} resolves to ${blocked}, which is blocked by AI_BLOCKED_CIDRS.`);
    }
}

/** fetch for every provider request: checks the destination and, when blocking is on, refuses redirects. */
export async function guardedFetch(input: Request | string | URL, init?: RequestInit): Promise<Response> {
    const url = input instanceof Request ? input.url : String(input);
    await assertAllowedEndpoint(url);
    return globalThis.fetch(input, env.AI_BLOCKED_CIDRS.length > 0 ? { ...init, redirect: "error" } : init);
}
