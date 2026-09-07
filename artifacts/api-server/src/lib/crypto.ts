import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM helpers for per-user secrets stored in PostgreSQL.
 *
 * Encrypted payload format: base64url(iv) + "." + base64url(authTag) + "." +
 * base64url(ciphertext). GCM authenticates the ciphertext so a rotated or
 * wrong key surfaces as a throw during decrypt — never as corrupted plaintext.
 *
 * The 32-byte key comes from CREDENTIALS_ENCRYPTION_KEY (64 hex chars or
 * base64). Keep it stable: rotating it makes every previously stored secret
 * undecryptable (callers surface that as an "unreadable" credential state).
 */

function rawEncryptionKey(): Buffer {
  const raw = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  if (!raw) {
    throw new Error(
      "CREDENTIALS_ENCRYPTION_KEY is required to persist secrets. " +
        "Set it (32 bytes as 64 hex chars or base64) in the API deployment environment.",
    );
  }
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

export function canEncrypt(): boolean {
  const raw = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  if (!raw) return false;
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  return key.length === 32;
}

export function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", rawEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(value: string): string {
  const [ivValue, tagValue, ciphertextValue] = value.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Stored secret payload is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", rawEncryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}
