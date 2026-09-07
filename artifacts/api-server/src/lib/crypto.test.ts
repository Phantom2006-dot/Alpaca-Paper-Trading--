import { test } from "node:test";
import assert from "node:assert/strict";

// These tests read CREDENTIALS_ENCRYPTION_KEY at call time, so set it before
// importing the module under test.
process.env["CREDENTIALS_ENCRYPTION_KEY"] = "a".repeat(64);

import { canEncrypt, decrypt, encrypt } from "./crypto";

// Run with tsx (Node's type stripping cannot resolve extensionless imports):
//   node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs --test \
//     artifacts/api-server/src/lib/crypto.test.ts \
//     artifacts/api-server/src/lib/credentials.test.ts

test("canEncrypt accepts a 64-hex-char key", () => {
  assert.equal(canEncrypt(), true);
});

test("encrypt/decrypt round-trips a secret", () => {
  const ciphertext = encrypt("PK_SECRET_123");
  assert.notEqual(ciphertext, "PK_SECRET_123");
  assert.match(ciphertext, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(decrypt(ciphertext), "PK_SECRET_123");
});

test("every encryption uses a fresh IV (no two ciphertexts are equal)", () => {
  const first = encrypt("same-value");
  const second = encrypt("same-value");
  assert.notEqual(first, second);
  assert.equal(decrypt(first), decrypt(second));
});

test("decrypt throws when the key is rotated (auth tag mismatch)", () => {
  const ciphertext = encrypt("PK_ROTATE_ME");
  process.env["CREDENTIALS_ENCRYPTION_KEY"] = "b".repeat(64);
  try {
    assert.throws(() => decrypt(ciphertext));
  } finally {
    process.env["CREDENTIALS_ENCRYPTION_KEY"] = "a".repeat(64);
  }
});

test("decrypt throws on a malformed payload", () => {
  assert.throws(() => decrypt("not-a-valid-payload"));
  assert.throws(() => decrypt("only-once-piece"));
});

test("canEncrypt rejects a wrong-length key", () => {
  const previous = process.env["CREDENTIALS_ENCRYPTION_KEY"];
  process.env["CREDENTIALS_ENCRYPTION_KEY"] = "too-short";
  try {
    assert.equal(canEncrypt(), false);
  } finally {
    process.env["CREDENTIALS_ENCRYPTION_KEY"] = previous;
  }
});
