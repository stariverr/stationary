/**
 * Provider requests in tests are answered by fake fetch handlers on made-up hosts, so the egress
 * guard (features/ai/providers/egress.ts) must not resolve them. tests/ai-egress.test.ts turns it on.
 */
process.env.AI_ALLOW_PRIVATE_NETWORK = "true";
