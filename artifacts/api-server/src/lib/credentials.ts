import pg from "pg";
import { logger } from "./logger";
import { canEncrypt, decrypt, encrypt } from "./crypto";

const { Pool } = pg;

/**
 * Per-user Alpaca paper credentials, encrypted at rest.
 *
 * Storage model (in priority order):
 *  1. PostgreSQL (DATABASE_URL + CREDENTIALS_ENCRYPTION_KEY) — durable and
 *     shared across serverless instances. This is what makes "save once,
 *     auto-load on every login" work on Vercel.
 *  2. Process-local memory map — a convenience fallback for long-running
 *     single-process development and for short TTL caching of DB reads.
 *     Never treat this as durable: it is lost on restart and does not exist
 *     on other serverless instances.
 *
 * The table is created lazily and idempotently so a fresh database "just
 * works" — deployments no longer silently degrade to memory-only storage just
 * because `drizzle-kit push` was never run.
 *
 * Lifecycle states exposed to callers:
 *  - "none"        — no stored credentials anywhere (fresh user → demo mode).
 *  - "memory"      — active in this process only (no DATABASE_URL configured).
 *  - "database"    — encrypted row exists and decrypts cleanly.
 *  - "unreadable"  — a row exists but cannot be decrypted (e.g. the encryption
 *                    key was rotated). Must NOT be reported as demo mode: the
 *                    UI should prompt the user to re-enter their keys.
 */

type Credentials = { apiKey: string; apiSecret: string };

type StoredCredentials = {
  encryptedApiKey: string;
  encryptedApiSecret: string;
};

export type SaveCredentialsResult = {
  /** True when the encrypted copy reached PostgreSQL. */
  persistedToDatabase: boolean;
  /** True when the keys are usable by the current process right now. */
  activeInMemory: boolean;
};

export type CredentialStatus =
  | { state: "none"; storage: null }
  | { state: "memory"; storage: "memory" }
  | {
      state: "database";
      storage: "database";
      keyLast4: string;
      updatedAt: string | null;
    }
  | {
      state: "unreadable" | "configuration_error";
      storage: "database";
      message: string;
    };

// Lazily created pool; null when the optional database is not configured.
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;
const TABLE_NAME = "alpaca_credentials";

/**
 * Process-local credential cache with a short TTL. Every entry written here is
 * also what makes per-request credential loading cheap: status and dashboard
 * endpoints poll frequently, and we do not want one SELECT per request.
 *
 * Entries hold their own timestamp so a long-running process (local dev, a
 * non-serverless deployment) can revalidate against Postgres periodically and
 * pick up writes made by other instances or devices.
 */
type MemoryEntry = { credentials: Credentials; updatedAt: string; writtenAt: number };
const memoryCredentials = new Map<string, MemoryEntry>();
const MEMORY_TTL_MS = 30_000;

// Must stay in sync with `lib/db/src/schema/index.ts`.
const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
    user_id text PRIMARY KEY,
    encrypted_api_key text NOT NULL,
    encrypted_api_secret text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
  )
`;

let schemaReady: Promise<void> | null = null;

/**
 * Turn raw Postgres connection failures into actionable guidance.
 * The most common case on Vercel: Supabase direct-connection hosts
 * (db.<ref>.supabase.co) resolve to IPv6 only, and Vercel serverless
 * functions cannot dial IPv6 — the request fails with getaddrinfo ENOTFOUND.
 * The fix is Supabase's Session Pooler hostname, which has IPv4 A records.
 */
function describeDbError(error: unknown): string {
  const err = error as { code?: string; message?: string; hostname?: string };
  const message = err?.message ?? "";
  if (err?.code === "ENOTFOUND" || /getaddrinfo ENOTFOUND/i.test(message)) {
    const host =
      err?.hostname ?? /ENOTFOUND\s+(\S+)/i.exec(message)?.[1] ?? "the database host";
    return (
      `Database host could not be resolved (DNS): ${host}. ` +
      `If this is a Supabase direct host (db.<ref>.supabase.co), it is IPv6-only and unreachable from Vercel serverless. ` +
      `Use the Session Pooler string instead: Supabase dashboard → Connect → Session pooler → ` +
      `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres`
    );
  }
  return error instanceof Error ? error.message : String(error);
}

async function ensureSchema(): Promise<void> {
  if (!pool) return;
  // Cache the promise so the DDL runs at most once per process/instance even
  // if several requests race at cold start.
  if (!schemaReady) {
    schemaReady = pool
      .query(TABLE_DDL)
      .then(() => {
        logger.info("Alpaca credentials table is ready");
      })
      .catch((error: unknown) => {
        // Clear the cache so a transient failure can be retried later.
        schemaReady = null;
        throw new Error(
          `Credential storage is unavailable: could not create the ${TABLE_NAME} table. ` +
            `Check DATABASE_URL and database permissions. ${describeDbError(error)}`,
        );
      });
  }
  return schemaReady;
}

function keyLast4(apiKey: string): string {
  return apiKey.length > 4 ? apiKey.slice(-4) : apiKey;
}

async function fetchStoredRow(userId: string): Promise<(StoredCredentials & { updatedAt: string | null }) | null> {
  if (!pool || !canEncrypt()) return null;
  await ensureSchema();
  const result = await pool.query<StoredCredentials & { updatedAt: string | null }>(
    `SELECT
       encrypted_api_key AS "encryptedApiKey",
       encrypted_api_secret AS "encryptedApiSecret",
       updated_at AS "updatedAt"
     FROM ${TABLE_NAME} WHERE user_id = $1 LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/**
 * Validates and stores credentials for a user. Alpaca validation happens in
 * the caller; this function only persists.
 *
 * - Always makes the keys active in the current process.
 * - When a database is configured, persistence is *required*: if the table
 *   cannot be created or the insert fails, an error is thrown instead of
 *   silently pretending the user's keys are safely stored. On serverless
 *   (Vercel) a memory-only save is effectively a no-op for the next request,
 *   so it must not be reported as success.
 * - When no database is configured (local development), the keys are stored
 *   in memory and the result reports `persistedToDatabase: false`.
 */
export async function saveCredentials(
  userId: string,
  credentials: Credentials,
): Promise<SaveCredentialsResult> {
  // In production, do not activate credentials until the encrypted database
  // write has completed successfully. This prevents a failed persistence
  // request from appearing successful on a warm serverless instance.
  if (!pool) {
    memoryCredentials.set(userId, {
      credentials,
      updatedAt: new Date().toISOString(),
      writtenAt: Date.now(),
    });
    logger.warn(
      { userId },
      "Alpaca credentials saved to process memory only — DATABASE_URL is not configured, persistence skipped",
    );
    return { persistedToDatabase: false, activeInMemory: true };
  }

  if (!canEncrypt()) {
    throw new Error(
      "Persistence requires CREDENTIALS_ENCRYPTION_KEY (32 bytes as 64 hex chars or base64). " +
        "Set it in the API deployment environment so credentials can be stored for your account.",
    );
  }

  await ensureSchema();

  try {
    const stored: StoredCredentials = {
      encryptedApiKey: encrypt(credentials.apiKey),
      encryptedApiSecret: encrypt(credentials.apiSecret),
    };
    await pool.query(
      `INSERT INTO ${TABLE_NAME} (user_id, encrypted_api_key, encrypted_api_secret, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE SET encrypted_api_key = $2, encrypted_api_secret = $3, updated_at = NOW()`,
      [userId, stored.encryptedApiKey, stored.encryptedApiSecret],
    );
    memoryCredentials.set(userId, {
      credentials,
      updatedAt: new Date().toISOString(),
      writtenAt: Date.now(),
    });
    return { persistedToDatabase: true, activeInMemory: true };
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to persist Alpaca credentials to the database");
    throw new Error(
      `Persistence failed: your Alpaca keys were verified but could not be saved to the database. ` +
        `${describeDbError(error)}`,
    );
  }
}

/**
 * Loads stored credentials for a user. Resolution order:
 *  1. Fresh in-memory entry (updated within MEMORY_TTL_MS) → return it.
 *  2. PostgreSQL row → decrypt, refresh the memory cache, return it.
 *  3. Nothing stored → null (callers run in demo mode).
 *
 * A stored row that cannot be decrypted (rotated CREDENTIALS_ENCRYPTION_KEY or
 * corrupt payload) logs the failure and returns null so the request still
 * serves demo data — but the tri-state `getCredentialStatus()` reports
 * `unreadable` so the UI can prompt re-entry instead of claiming demo mode.
 */
export async function loadCredentials(userId: string): Promise<Credentials | null> {
  const inMemory = memoryCredentials.get(userId);
  if (inMemory && Date.now() - inMemory.writtenAt < MEMORY_TTL_MS) {
    return inMemory.credentials;
  }

  if (!pool) return inMemory?.credentials ?? null;
  if (!canEncrypt()) return null;

  try {
    const record = await fetchStoredRow(userId);
    if (!record) return null;
    const credentials: Credentials = {
      apiKey: decrypt(record.encryptedApiKey),
      apiSecret: decrypt(record.encryptedApiSecret),
    };
    memoryCredentials.set(userId, {
      credentials,
      updatedAt: record.updatedAt ?? new Date().toISOString(),
      writtenAt: Date.now(),
    });
    return credentials;
  } catch (error) {
    // A stored row that cannot be decrypted (rotated key, corrupt payload) is
    // NOT the same as "no credentials". We still fall back to demo data for
    // this request so the app keeps working, but log loudly — the UI surfaces
    // the difference via getCredentialStatus().
    logger.error({ err: error, userId }, "Unable to load credentials from the database; falling back to demo mode");
    return null;
  }
}

/**
 * Tri-state report used by GET /agent/credentials and the UI. Never returns
 * secrets — only storage source, last-4 of the key, and updated-at.
 */
export async function getCredentialStatus(userId: string): Promise<CredentialStatus> {
  const inMemory = memoryCredentials.get(userId);

  if (pool) {
    if (!canEncrypt()) {
      return {
        state: "configuration_error",
        storage: "database",
        message:
          "Credential persistence is configured with DATABASE_URL, but CREDENTIALS_ENCRYPTION_KEY is missing or invalid. Set a stable 32-byte key on the API deployment, then re-enter your Alpaca keys.",
      };
    }

    try {
      const record = await fetchStoredRow(userId);
      if (record) {
        try {
          const credentials: Credentials = {
            apiKey: decrypt(record.encryptedApiKey),
            apiSecret: decrypt(record.encryptedApiSecret),
          };
          // Refresh the memory cache so subsequent loads are cheap.
          memoryCredentials.set(userId, {
            credentials,
            updatedAt: record.updatedAt ?? new Date().toISOString(),
            writtenAt: Date.now(),
          });
          return {
            state: "database",
            storage: "database",
            keyLast4: keyLast4(credentials.apiKey),
            updatedAt: record.updatedAt,
          };
        } catch (error) {
          logger.error({ err: error, userId }, "Credential row present but unreadable");
          return {
            state: "unreadable",
            storage: "database",
            message:
              "Credentials are stored for this account but could not be decrypted. " +
              "This usually means the server's encryption key changed. Re-enter your Alpaca keys to fix it.",
          };
        }
      }
    } catch (error) {
      // DB down — report memory state if we have one, otherwise none.
      logger.error({ err: error, userId }, "Unable to check credential status in the database");
    }
  }

  if (inMemory && !pool) {
    return { state: "memory", storage: "memory" };
  }
  return { state: "none", storage: null };
}

/**
 * Removes stored credentials (memory + database row) for a user.
 */
export async function deleteCredentials(userId: string): Promise<{ deletedFromDatabase: boolean }> {
  memoryCredentials.delete(userId);

  if (!pool) {
    return { deletedFromDatabase: false };
  }

  await ensureSchema();
  try {
    await pool.query(`DELETE FROM ${TABLE_NAME} WHERE user_id = $1`, [userId]);
    logger.info({ userId }, "Alpaca credentials deleted");
    return { deletedFromDatabase: true };
  } catch (error) {
    logger.error({ err: error, userId }, "Failed to delete Alpaca credentials from the database");
    throw new Error(
      `Delete failed: your keys were removed from this server's memory but the database row could not be removed. ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Test helper — clears the per-process cache and any cached schema promise so
 * each test starts from a clean slate. Does not drop the table.
 */
export function _resetCredentialCacheForTests(): void {
  memoryCredentials.clear();
  schemaReady = null;
}
