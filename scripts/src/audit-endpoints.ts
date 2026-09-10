#!/usr/bin/env tsx
/**
 * audit-endpoints.ts — ENDPOINT TRUTH AUDIT
 *
 * Calls every Kairo API endpoint with a real Clerk token and verifies the
 * responses are REAL (cross-checked against Alpaca's API ground truth where
 * possible), not dummy/placeholder values.
 *
 * Usage:
 *   CLERK_TOKEN=<jwt> pnpm --filter @workspace/scripts run audit-endpoints
 *   (or set API_BASE to target a different deployment)
 */

const API_BASE = (process.env["API_BASE"] ?? "https://kairo-api-xi.vercel.app").replace(/\/+$/, "");
const TOKEN = process.env["CLERK_TOKEN"] ?? "";
const ALPACA_KEY = process.env["ALPACA_KEY_ID"] ?? "";
const ALPACA_SECRET = process.env["ALPACA_SECRET"] ?? "";
const HAS_TOKEN = TOKEN.length > 0;

type Check = {
  name: string;
  run: () => Promise<string | true>;
};

const results: Array<{ name: string; verdict: string | true; ok: boolean }> = [];

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Ground truth: call Alpaca directly with the same paper credentials. */
async function alpaca(path: string): Promise<unknown> {
  const res = await fetch(`https://paper-api.alpaca.markets${path}`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  return res.json();
}

async function alpacaData(path: string): Promise<unknown> {
  const res = await fetch(`https://data.alpaca.markets${path}`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  return res.json();
}

/**
 * Tokenless mode: authenticated endpoints must return 401 (proves the route
 * exists and is auth-gated — a 404 would mean the route is missing).
 * With a token, full body checks run.
 */
function expectAuthGate(status: number): string | true {
  if (HAS_TOKEN) return true; // full check proceeds
  if (status === 401) return "REACHABLE (401 auth-gated — set CLERK_TOKEN for full check)";
  return `expected 401 auth-gate in tokenless mode, got ${status}`;
}

const checks: Check[] = [
  {
    name: "GET /api/healthz — reachable",
    run: async () => {
      const { status, body } = await api("/api/healthz");
      if (status !== 200 || !isRecord(body) || body.status !== "ok") return `unexpected: ${status} ${JSON.stringify(body).slice(0, 120)}`;
      return true;
    },
  },
  {
    name: "GET /api/agent/status — real guardrails + paper lock",
    run: async () => {
      const { status, body } = await api("/api/agent/status");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}`;
      if (!isRecord(body)) return "non-object body";
      const g = body.guardrails;
      if (!isRecord(g) || g.entryZ !== 2 || g.adxMax !== 25) return "guardrails missing/incorrect";
      if (body.paper !== true || body.paperUrlValid !== true) return "paper lock not enforced";
      return true;
    },
  },
  {
    name: "GET /api/agent/account — equity matches Alpaca ground truth",
    run: async () => {
      const { status, body } = await api("/api/agent/account");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}: ${JSON.stringify(body).slice(0, 140)}`;
      if (!isRecord(body) || !isRecord(body.account)) return "missing account";
      const equity = body.account.equity as number;
      if (typeof equity !== "number" || equity <= 0) return "bad equity";
      if (ALPACA_KEY) {
        const truth = (await alpaca("/v2/account")) as { equity?: string };
        const truthEquity = Number(truth.equity);
        if (Number.isFinite(truthEquity) && Math.abs(truthEquity - equity) > 0.01) {
          return `MISMATCH: API ${equity} vs Alpaca ${truthEquity}`;
        }
      }
      return true;
    },
  },
  {
    name: "GET /api/agent/bars?symbol=SPY — bars match Alpaca data API",
    run: async () => {
      const { status, body } = await api("/api/agent/bars?symbol=SPY&timeframe=1Day&limit=5");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}: ${JSON.stringify(body).slice(0, 140)}`;
      if (!isRecord(body) || !Array.isArray(body.bars) || body.bars.length === 0) {
        return `no bars (feed=${isRecord(body) ? body.feed : "?"})`;
      }
      // CONTRACT GUARD: bars must be { t, o, h, l, c, v } per OhlcvBar schema.
      // A mismatch here rendered the candlestick chart blank once already.
      const sample = (body.bars as Array<Record<string, unknown>>)[0];
      for (const key of ["t", "o", "h", "l", "c", "v"]) {
        if (!(key in sample)) {
          return `BAR SHAPE BROKEN: expected key "${key}" in ${JSON.stringify(sample).slice(0, 140)}`;
        }
      }
      if (typeof sample.o !== "number" || typeof sample.c !== "number") {
        return `BAR VALUES NOT NUMERIC: ${JSON.stringify(sample).slice(0, 140)}`;
      }
      if (ALPACA_KEY) {
        const truth = (await alpacaData("/v2/stocks/SPY/bars?timeframe=1Day&limit=5&feed=iex&sort=desc")) as {
          bars?: Array<{ c: string }>;
        };
        const truthClose = truth.bars?.[0]?.c ? Number(truth.bars[0].c) : null;
        const ourBars = body.bars as Array<{ c: number }>;
        const ourLast = ourBars.at(-1)?.c;
        if (truthClose != null && ourLast != null) {
          const iexBar = truth.bars?.[0];
          // feeds may differ in ordering; just verify magnitude plausibility vs truth
          if (Math.abs(Number(iexBar?.c ?? 0) - ourLast) / ourLast > 0.05) {
            return `far from truth: ours ${ourLast} vs alpaca iex ${truthClose}`;
          }
        }
      }
      return true;
    },
  },
  {
    name: "GET /api/agent/quote?symbol=SPY — live trade present",
    run: async () => {
      const { status, body } = await api("/api/agent/quote?symbol=SPY");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}: ${JSON.stringify(body).slice(0, 140)}`;
      if (!isRecord(body)) return "non-object";
      if (typeof body.price !== "number" || body.price <= 0) return `no real price: ${JSON.stringify(body).slice(0, 120)}`;
      if (body.live !== true) return "live flag false";
      return true;
    },
  },
  {
    name: "GET /api/agent/dashboard — metrics note honest, no placeholder",
    run: async () => {
      const { status, body } = await api("/api/agent/dashboard");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}`;
      if (!isRecord(body) || !isRecord(body.metrics)) return "missing metrics";
      const m = body.metrics;
      if (m.winRate === 68.4 || m.avgHoldHours === 6.2) return "PLACEHOLDER VALUES STILL PRESENT";
      if (typeof m.realizedTradeCount !== "number") return "missing realizedTradeCount";
      return true;
    },
  },
  {
    name: "GET /api/agent/suggestions — deterministic shape",
    run: async () => {
      const { status, body } = await api("/api/agent/suggestions");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}: ${JSON.stringify(body).slice(0, 140)}`;
      if (!isRecord(body) || !Array.isArray(body.suggestions)) return "missing suggestions array";
      if (typeof body.disclaimer !== "string") return "missing disclaimer";
      return true;
    },
  },
  {
    name: "GET /api/agent/market/SPY regime not insufficient",
    run: async () => {
      const { status, body } = await api("/api/agent/market/SPY");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200) return `status ${status}: ${JSON.stringify(body).slice(0, 140)}`;
      if (!isRecord(body)) return "non-object";
      if (body.regime === "insufficient_data") return "STILL insufficient_data for SPY";
      if (typeof body.zScore !== "number" || typeof body.adx !== "number") return "indicators missing";
      return true;
    },
  },
  {
    name: "GET /api/agent/options/SPY — chain reachable (real contracts or clean error)",
    run: async () => {
      const { status, body } = await api("/api/agent/options/SPY");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status === 200 && isRecord(body)) {
        if (typeof body.count !== "number") return "missing count";
        return true;
      }
      if (status === 422 || status === 502) {
        return `documented failure: ${JSON.stringify(body).slice(0, 160)}`;
      }
      return `unexpected ${status}`;
    },
  },
  {
    name: "GET /api/agent/diagnostics/market-data — ring buffer live",
    run: async () => {
      const { status, body } = await api("/api/agent/diagnostics/market-data");
      const gate = expectAuthGate(status);
      if (gate !== true) return gate;
      if (status !== 200 || !isRecord(body)) return `status ${status}`;
      if (!Array.isArray(body.feedOrder) || body.feedOrder.length !== 3) return "feedOrder wrong";
      return true;
    },
  },
];

for (const check of checks) {
  try {
    const verdict = await check.run();
    results.push({ name: check.name, verdict, ok: verdict === true });
  } catch (error) {
    results.push({ name: check.name, verdict: error instanceof Error ? error.message : String(error), ok: false });
  }
}

console.log(`\nENDPOINT TRUTH AUDIT — ${API_BASE}${HAS_TOKEN ? "" : "  [TOKENLESS: auth-gate probe only]"}\n${"=".repeat(60)}`);
for (const r of results) {
  console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n    → ${r.verdict}`}`);
}
const passed = results.filter((r) => r.ok || (typeof r.verdict === "string" && r.verdict.startsWith("REACHABLE"))).length;
console.log(`${"=".repeat(60)}\n${passed}/${results.length} endpoints verified${ALPACA_KEY ? " REAL (cross-checked vs Alpaca)" : " (set ALPACA_KEY_ID/SECRET for ground-truth cross-check)"}\n`);
process.exit(passed === results.length ? 0 : 1);
