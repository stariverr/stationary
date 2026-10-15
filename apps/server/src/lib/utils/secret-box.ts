import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
}

/**
 * AES-256-GCM encryption for credentials stored in the database.
 * Ciphertext format: `v1:` + base64(iv | auth tag | encrypted bytes).
 */
export function createSecretBox(keyBase64: string): SecretBox {
    const key = Buffer.from(keyBase64, "base64");
    if (key.length !== 32) {
        throw new Error("Secret encryption key must be 32 bytes encoded as base64");
    }

    return {
        encrypt(plaintext) {
            const iv = randomBytes(IV_BYTES);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
            return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}`;
        },
        decrypt(ciphertext) {
            const [version, payload] = ciphertext.split(":", 2);
            if (version !== VERSION || !payload) {
                throw new Error("Unsupported secret ciphertext format");
            }
            const data = Buffer.from(payload, "base64");
            const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
            decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
            return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
        },
    };
}
