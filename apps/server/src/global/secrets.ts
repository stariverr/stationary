import { env } from "@/global/env";
import { createSecretBox } from "@/lib/utils/secret-box";

/** Encrypts credentials at rest, e.g. AI provider API keys. */
export const secretBox = createSecretBox(env.SECRETS_ENCRYPTION_KEY);
