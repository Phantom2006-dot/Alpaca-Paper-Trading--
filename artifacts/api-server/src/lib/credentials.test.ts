import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// The credentials module decides at import time whether Postgres is available.
// These unit tests exercise the process-local memory path (no DATABASE_URL set)
// and the pure status/delete logic. Database-backed paths need a real Postgres
// and are covered by the deployment smoke tests instead.
delete process.env["DATABASE_URL"];

// Run with tsx:
//   node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs --test \
//     artifacts/api-server/src/lib/crypto.test.ts \
//     artifacts/api-server/src/lib/credentials.test.ts

let credentials: typeof import("./credentials");

beforeEach(async () => {
  credentials = await import("./credentials");
  credentials._resetCredentialCacheForTests();
});

test("saveCredentials in memory mode reports not persisted but active", async () => {
  const result = await credentials.saveCredentials("user-1", {
    apiKey: "PK_ABC123",
    apiSecret: "secret-1",
  });
  assert.equal(result.persistedToDatabase, false);
  assert.equal(result.activeInMemory, true);
});

test("loadCredentials returns the saved memory credentials", async () => {
  await credentials.saveCredentials("user-1", { apiKey: "PK_ABC123", apiSecret: "secret-1" });
  const loaded = await credentials.loadCredentials("user-1");
  assert.deepEqual(loaded, { apiKey: "PK_ABC123", apiSecret: "secret-1" });
});

test("loadCredentials returns null for a user with nothing stored", async () => {
  assert.equal(await credentials.loadCredentials("user-ghost"), null);
});

test("getCredentialStatus reports none before save, memory after save", async () => {
  assert.deepEqual(await credentials.getCredentialStatus("user-2"), { state: "none", storage: null });

  await credentials.saveCredentials("user-2", { apiKey: "PK_ABC123", apiSecret: "secret-1" });
  const status = await credentials.getCredentialStatus("user-2");
  assert.deepEqual(status, { state: "memory", storage: "memory" });
});

test("users are isolated from one another in memory mode", async () => {
  await credentials.saveCredentials("user-a", { apiKey: "PK_A", apiSecret: "secret-a" });
  await credentials.saveCredentials("user-b", { apiKey: "PK_B", apiSecret: "secret-b" });

  assert.deepEqual(await credentials.loadCredentials("user-a"), { apiKey: "PK_A", apiSecret: "secret-a" });
  assert.deepEqual(await credentials.loadCredentials("user-b"), { apiKey: "PK_B", apiSecret: "secret-b" });

  await credentials.deleteCredentials("user-a");
  assert.equal(await credentials.loadCredentials("user-a"), null);
  assert.deepEqual(await credentials.loadCredentials("user-b"), { apiKey: "PK_B", apiSecret: "secret-b" });
});

test("deleteCredentials clears memory and reports no DB row deleted", async () => {
  await credentials.saveCredentials("user-3", { apiKey: "PK_ABC123", apiSecret: "secret-1" });
  const result = await credentials.deleteCredentials("user-3");
  assert.deepEqual(result, { deletedFromDatabase: false });
  assert.equal(await credentials.loadCredentials("user-3"), null);
  assert.deepEqual(await credentials.getCredentialStatus("user-3"), { state: "none", storage: null });
});

test("re-saving overwrites the previous credentials", async () => {
  await credentials.saveCredentials("user-4", { apiKey: "PK_OLD", apiSecret: "old" });
  await credentials.saveCredentials("user-4", { apiKey: "PK_NEW", apiSecret: "new" });
  assert.deepEqual(await credentials.loadCredentials("user-4"), { apiKey: "PK_NEW", apiSecret: "new" });
});
