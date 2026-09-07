import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import pino from "pino";

// Demo mode (no DATABASE_URL, no Alpaca env keys) runs entirely on synthetic
// data, so these tests exercise the real per-user runtime plumbing without any
// external dependency.
delete process.env["DATABASE_URL"];
delete process.env["ALPACA_API_KEY"];
delete process.env["ALPACA_API_SECRET"];

const silentLogger = pino({ level: "silent" });

// Run with tsx:
//   node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs --test \
//     artifacts/api-server/src/lib/strategy.test.ts

let strategy: typeof import("./strategy");

beforeEach(async () => {
  strategy = await import("./strategy");
  strategy._resetAgentRuntimesForTests();
});

test("withUserCredentials scopes engine state per user", async () => {
  // User A runs a strategy scan in demo mode — the runtime records it for A.
  await strategy.withUserCredentials("user-a", async () => {
    await strategy.runStrategy(["SPY"], true, silentLogger);
  });

  const auditForA = await strategy.withUserCredentials("user-a", async () => strategy.getAuditRuns().length);
  const auditForB = await strategy.withUserCredentials("user-b", async () => strategy.getAuditRuns().length);

  assert.ok(auditForA > 0, "user A should have audit records");
  assert.equal(auditForB, 0, "user B must not see user A's audit trail");
});

test("start/stop agent affects only the acting user's runtime", async () => {
  await strategy.withUserCredentials("user-a", async () => {
    await strategy.startAgent(["SPY", "QQQ"], 60, silentLogger);
  });

  const statusA = await strategy.withUserCredentials("user-a", async () => strategy.getStatus());
  const statusB = await strategy.withUserCredentials("user-b", async () => strategy.getStatus());

  assert.equal(statusA.running, true);
  assert.deepEqual(statusA.symbols, ["SPY", "QQQ"]);

  assert.equal(statusB.running, false, "user B must not inherit user A's automation");
  assert.deepEqual(statusB.symbols, ["SPY", "QQQ", "IWM", "AAPL"], "user B keeps the default symbol universe");

  // Stopping from a different user must not stop user A's loop.
  await strategy.withUserCredentials("user-b", async () => {
    strategy.stopAgent(silentLogger);
  });
  const stillRunning = await strategy.withUserCredentials("user-a", async () => (await strategy.getStatus()).running);
  assert.equal(stillRunning, true);

  await strategy.withUserCredentials("user-a", async () => {
    strategy.stopAgent(silentLogger);
  });
  const stopped = await strategy.withUserCredentials("user-a", async () => (await strategy.getStatus()).running);
  assert.equal(stopped, false);
});

test("manual trades in demo mode keep per-user positions", async () => {
  await strategy.withUserCredentials("user-a", async () => {
    await strategy.placeManualTrade("SPY", "buy", 5, "market", null, null);
  });
  await strategy.withUserCredentials("user-b", async () => {
    await strategy.placeManualTrade("AAPL", "buy", 3, "market", null, null);
  });

  const accountA = await strategy.withUserCredentials("user-a", async () => strategy.getAgentAccount());
  const accountB = await strategy.withUserCredentials("user-b", async () => strategy.getAgentAccount());

  const symbolsA = accountA.positions.map((position) => position.symbol);
  const symbolsB = accountB.positions.map((position) => position.symbol);
  assert.ok(symbolsA.includes("SPY"));
  assert.ok(!symbolsA.includes("AAPL"), "user A must not see user B's demo position");
  assert.ok(symbolsB.includes("AAPL"));
  assert.ok(!symbolsB.includes("SPY"), "user B must not see user A's demo position");
});
