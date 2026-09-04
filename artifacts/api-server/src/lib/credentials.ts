import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const TABLE_NAME = "alpaca_credentials";

type Credentials = { apiKey: string; apiSecret: string };

type StoredCredentials = {
  encryptedApiKey: string;
  encryptedApiSecret: string;
};

function encryptionKey(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error("CREDENTIALS_ENCRYPTION_KEY is required to store Alpaca credentials.");
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  return key;
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64url")).join(".");
}

function decrypt(value: string): string {
  const [ivValue, tagValue, ciphertextValue] = value.split(".");
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error("Stored credential payload is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextValue, "base64url")), decipher.final()]).toString("utf8");
}

function requirePool(): pg.Pool {
  if (!pool) throw new Error("DATABASE_URL is required to persist Alpaca credentials.");
  return pool;
}

export async function saveCredentials(userId: string, credentials: Credentials): Promise<void> {
  const stored: StoredCredentials = {
    encryptedApiKey: encrypt(credentials.apiKey),
    encryptedApiSecret: encrypt(credentials.apiSecret),
  };
  await requirePool().query(
    `INSERT INTO ${TABLE_NAME} (user_id, encrypted_api_key, encrypted_api_secret, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET encrypted_api_key = $2, encrypted_api_secret = $3, updated_at = NOW()`,
    [userId, stored.encryptedApiKey, stored.encryptedApiSecret],
  );
}

export async function loadCredentials(userId: string): Promise<Credentials | null> {
  if (!pool) return null;
  const result = await pool.query<StoredCredentials>(
    `SELECT encrypted_api_key AS "encryptedApiKey", encrypted_api_secret AS "encryptedApiSecret"
     FROM ${TABLE_NAME} WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  const record = result.rows[0];
  return record ? { apiKey: decrypt(record.encryptedApiKey), apiSecret: decrypt(record.encryptedApiSecret) } : null;
}
