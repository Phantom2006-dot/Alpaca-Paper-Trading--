import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { loadCredentials } from "./credentials";
import { logger } from "./logger";

import type { Logger } from "pino";

import {
  GetAgentDashboardResponse,
  GetAgentStatusResponse,
  GetMarketSnapshotResponse,
  RunStrategyResponse,
  FlattenAgentPositionsResponse,
  RunBacktestResponse,
  OptimizeBacktestResponse,
  GetAgentAssetsResponse,
  GetAgentAccountResponse,
  StartAgentResponse,
  StopAgentResponse,
  PlaceManualTradeResponse,
} from "@workspace/api-zod";

type Bar = {
  timestamp?: string;
  open?: number;
  close: number;
  high: number;
  low: number;
  volume: number;
};

// ─── MARKET-DATA DIAGNOSTICS ─────────────────────────────────────────────────
// Every upstream bar-fetch failure is recorded here so the UI can explain
// empty charts / "insufficient_data" regimes instead of failing silently.
const marketDataLog: Array<{
  at: string;
  host: string;
  status: number | null;
  message: string;
  feed: string | null;
}> = [];

function recordMarketDataFailure(error: unknown, feed: string | null): void {
  const err = error as { message?: string; status?: number };
  marketDataLog.unshift({
    at: new Date().toISOString(),
    host: "data.alpaca.markets",
    status: typeof err?.status === "number" ? err.status : null,
    message: (err?.message ?? String(error)).slice(0, 300),
    feed,
  });
  if (marketDataLog.length > 25) marketDataLog.length = 25;
}

export function getMarketDataDiagnostics() {
  return {
    checkedAt: new Date().toISOString(),
    feedOrder: ["iex", "sip", "delayed_sip"],
    recent: marketDataLog.slice(0, 10),
  };
}

export type Timeframe = "1Min" | "5Min" | "15Min" | "1Hour" | "1Day";
export type DataFeed = "iex" | "sip" | "delayed_sip";
export type StrategyMode = "zscore" | "ict_hmm";

type Position = {
  symbol: string;
  qty: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPnl: number;
};

type Snapshot = ReturnType<typeof GetMarketSnapshotResponse.parse>;
type Activity = ReturnType<typeof GetAgentDashboardResponse.parse>["activity"][number];

type AlpacaCredentials = { apiKey: string; apiSecret: string };

/**
 * Per-request async context. Carries both the authenticated user id and the
 * Alpaca credentials resolved for that user so every downstream engine call
 * (and the automation loop it starts) is bound to exactly one user.
 */
type AgentSession = {
  userId: string;
  credentials: AlpacaCredentials;
};
const requestCredentials = new AsyncLocalStorage<AgentSession>();

const DEMO_USER_ID = "local-dev-user";

function currentUserId(): string {
  return requestCredentials.getStore()?.userId ?? DEMO_USER_ID;
}

export async function validateAlpacaCredentials(credentials: AlpacaCredentials): Promise<void> {
  const response = await fetch(`${PAPER_TRADING_URL}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID": credentials.apiKey,
      "APCA-API-SECRET-KEY": credentials.apiSecret,
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Alpaca rejected these paper credentials (${response.status}): ${message.slice(0, 180)}`);
  }
}

export async function withUserCredentials<T>(userId: string, callback: () => T | Promise<T>): Promise<T> {
  const credentials = await loadCredentials(userId);
  return requestCredentials.run(
    { userId, credentials: credentials ?? { apiKey: "", apiSecret: "" } },
    callback,
  );
}

function getAlpacaCredentials(): AlpacaCredentials {
  const scoped = requestCredentials.getStore()?.credentials;
  return scoped ?? {
    apiKey: process.env["ALPACA_API_KEY"] ?? "",
    apiSecret: process.env["ALPACA_API_SECRET"] ?? "",
  };
}

export type AuditRun = Activity & {
  runId: string;
  latencyMs: number;
  modelName: string;
  outcome: "EXECUTED" | "BLOCKED_BY_RISK" | "NEUTRAL_SIGNAL";
  marketSnapshot: object;
  modelOutput: object;
  riskValidatorResult: object;
  alpacaResponse: object | null;
};

const DEFAULT_SYMBOLS = ["SPY", "QQQ", "IWM", "AAPL"];
const PAPER_TRADING_URL = "https://paper-api.alpaca.markets";
const MARKET_DATA_URL = "https://data.alpaca.markets/v2";

// ─── IDEMPOTENCY STORE ────────────────────────────────────────────────────────
const recentIdempotencyKeys = new Map<string, number>(); // key → timestamp ms
const IDEMPOTENCY_TTL_MS = 60_000;

function checkIdempotency(key: string | undefined): void {
  if (!key) return;
  const now = Date.now();
  // Prune expired keys
  for (const [k, ts] of recentIdempotencyKeys) {
    if (now - ts > IDEMPOTENCY_TTL_MS) recentIdempotencyKeys.delete(k);
  }
  if (recentIdempotencyKeys.has(key)) {
    throw new Error(`Duplicate idempotency key: ${key}. This order was already submitted within the last 60 seconds.`);
  }
  recentIdempotencyKeys.set(key, now);
}

// ─── ICT/SMC + HMM ENGINE ────────────────────────────────────────────────────

/** Lightweight 3-state HMM approximation (no hmmlearn dependency).
 *  Uses log-return statistics over a rolling window to classify regime:
 *  - Expansion  : high positive mean return
 *  - Retracement: high negative mean return
 *  - Consolidation: low absolute mean, low volatility
 */
function classifyRegimeHmm(bars: Bar[]): {
  regime: "Expansion" | "Retracement" | "Consolidation" | "Unclassified";
  confidence: number;
  awd: number;
  directionalBias: 1 | -1;
} {
  if (bars.length < 30) return { regime: "Unclassified", confidence: 0, awd: 0, directionalBias: 1 };
  const closes = bars.map((b) => b.close);
  const logReturns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const r = Math.log(closes[i] / closes[i - 1]);
    if (Number.isFinite(r)) logReturns.push(r);
  }
  const recent = logReturns.slice(-20);
  const full = logReturns.slice(-100);
  const recentMean = mean(recent);
  const recentStd = standardDeviation(recent) || 1e-9;
  const fullStd = standardDeviation(full) || 1e-9;
  const slopeFactor = Math.min(Math.abs(recentMean) / recentStd, 1);
  const volRatio = Math.min(recentStd / fullStd, 2) / 2;
  let regime: "Expansion" | "Retracement" | "Consolidation" | "Unclassified";
  let confidence: number;
  if (recentMean > recentStd * 0.3) {
    regime = "Expansion";
    confidence = Math.min(recentMean / (recentStd * 0.5), 1);
  } else if (recentMean < -recentStd * 0.3) {
    regime = "Retracement";
    confidence = Math.min(Math.abs(recentMean) / (recentStd * 0.5), 1);
  } else {
    regime = "Consolidation";
    confidence = Math.max(0, 1 - slopeFactor * 2);
  }
  const awd = Math.min(0.45 * confidence + 0.35 * slopeFactor + 0.20 * volRatio, 1);
  const directionalBias: 1 | -1 = recentMean >= 0 ? 1 : -1;
  return { regime, confidence, awd, directionalBias };
}

/** Approximate ICT/SMC feature extraction from OHLCV bars.
 *  Causal: only uses bars up to and including the current bar.
 */
function extractSmcFeatures(bars: Bar[]): {
  fvgDirection: 1 | -1 | 0;
  bosDirection: 1 | -1 | 0;
  chochDirection: 1 | -1 | 0;
  liquiditySweep: boolean;
  displacement: boolean;
  displacementRatio: number;
  premiumDiscount: number;
  killzone: boolean;
  sponsorship: boolean;
  inducement: boolean;
} {
  const empty = { fvgDirection: 0 as const, bosDirection: 0 as const, chochDirection: 0 as const, liquiditySweep: false, displacement: false, displacementRatio: 0, premiumDiscount: 0.5, killzone: false, sponsorship: false, inducement: false };
  if (bars.length < 20) return empty;

  const last = bars.at(-1)!;
  const prev = bars.at(-2)!;
  const prev2 = bars.at(-3)!;

  // Fair Value Gap: 3-bar pattern — gap between bar[-3].high and bar[-1].low (bullish) or bar[-3].low and bar[-1].high (bearish)
  const bullFvg = prev2.high < last.low;
  const bearFvg = prev2.low > last.high;
  const fvgDirection: 1 | -1 | 0 = bullFvg ? 1 : bearFvg ? -1 : 0;

  // Swing highs/lows over last 10 bars for BoS/CHoCH
  const window = bars.slice(-10);
  const swingHigh = Math.max(...window.map((b) => b.high));
  const swingLow = Math.min(...window.map((b) => b.low));
  const prevWindow = bars.slice(-20, -10);
  const prevSwingHigh = Math.max(...prevWindow.map((b) => b.high));
  const prevSwingLow = Math.min(...prevWindow.map((b) => b.low));

  // Break of Structure: current close breaks prior swing
  const bosDirection: 1 | -1 | 0 =
    last.close > prevSwingHigh ? 1 : last.close < prevSwingLow ? -1 : 0;

  // Change of Character: close breaks structure in opposite direction of prior BoS
  const priorBos = prev.close > prevSwingHigh ? 1 : prev.close < prevSwingLow ? -1 : 0;
  const chochDirection: 1 | -1 | 0 =
    priorBos !== 0 && bosDirection !== 0 && bosDirection !== priorBos ? bosDirection : 0;

  // Liquidity sweep: wick beyond prior swing then close back inside
  const liquiditySweep =
    (last.high > prevSwingHigh && last.close < prevSwingHigh) ||
    (last.low < prevSwingLow && last.close > prevSwingLow);

  // ATR approximation (14-bar)
  const atrBars = bars.slice(-15);
  const trValues = atrBars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - atrBars[i].close), Math.abs(b.low - atrBars[i].close)),
  );
  const atr = mean(trValues) || 1e-9;

  // Displacement: large body candle relative to ATR
  const body = Math.abs(last.close - (last.close > prev.close ? prev.close : last.close));
  const candleRange = last.high - last.low || 1e-9;
  const displacementRatio = (last.high - last.low) / atr;
  const displacement = displacementRatio >= 1.5 && body / candleRange >= 0.6;

  // Premium / discount: position within 50-bar dealing range
  const rangeHigh = Math.max(...bars.slice(-50).map((b) => b.high));
  const rangeLow = Math.min(...bars.slice(-50).map((b) => b.low));
  const dealingRange = rangeHigh - rangeLow || 1e-9;
  const premiumDiscount = Math.max(0, Math.min(1, (last.close - rangeLow) / dealingRange));

  // Killzone: approximate London (07–10 UTC) / NY (12–15 UTC) using bar index parity
  // Without timestamps we use a heuristic: every 8th bar cluster is a session open
  const killzone = bars.length % 8 < 3;

  const sponsorship = displacement && (last.high - last.low) >= atr;
  const inducement = fvgDirection !== 0 && (bosDirection !== 0 || chochDirection !== 0);

  return { fvgDirection, bosDirection, chochDirection, liquiditySweep, displacement, displacementRatio, premiumDiscount, killzone, sponsorship, inducement };
}

/** TMA slope approximation: (close[-1] - close[-2]) / (ATR / 10) */
function tmaSlopeApprox(bars: Bar[]): number | null {
  if (bars.length < 15) return null;
  const closes = bars.map((b) => b.close);
  const t0 = closes.at(-2)!;
  const t1 = closes.at(-3)!;
  const atrBars = bars.slice(-15);
  const trValues = atrBars.slice(1).map((b, i) =>
    Math.max(b.high - b.low, Math.abs(b.high - atrBars[i].close), Math.abs(b.low - atrBars[i].close)),
  );
  const atr = mean(trValues);
  if (!atr) return null;
  return (t0 - t1) / (atr / 10);
}

type ClusterLabel =
  | "A - Institutional Reversal"
  | "B - Trend Expansion"
  | "C - Value Retracement"
  | "D - Correlation Basket"
  | "E - Range Liquidity"
  | null;

/** 5-cluster router — mirrors PowerX StrategyRouter.route() */
function routeCluster(
  regime: "Expansion" | "Retracement" | "Consolidation" | "Unclassified",
  awd: number,
  directionalBias: 1 | -1,
  smc: ReturnType<typeof extractSmcFeatures>,
  tmaSlope: number | null,
  minAwd = 0.65,
  tmaThreshold = 0.2,
): { cluster: ClusterLabel; direction: 1 | -1 | 0; reason: string } {
  if (awd < minAwd) return { cluster: null, direction: 0, reason: `AWD ${awd.toFixed(2)} below ${minAwd}` };
  if (smc.liquiditySweep && smc.chochDirection !== 0)
    return { cluster: "A - Institutional Reversal", direction: smc.chochDirection, reason: "sweep + CHoCH" };
  if (smc.bosDirection !== 0 && regime === "Expansion" && smc.displacement)
    return { cluster: "B - Trend Expansion", direction: smc.bosDirection, reason: "BoS + Expansion + displacement" };
  if (smc.fvgDirection !== 0 && smc.killzone && smc.inducement)
    return { cluster: "C - Value Retracement", direction: smc.fvgDirection, reason: "FVG + inducement + killzone" };
  if (tmaSlope !== null && Math.abs(tmaSlope) >= tmaThreshold && regime === "Consolidation")
    return { cluster: "D - Correlation Basket", direction: tmaSlope > 0 ? -1 : 1, reason: "TMA extreme + consolidation" };
  if (smc.killzone && regime === "Consolidation")
    return { cluster: "E - Range Liquidity", direction: directionalBias, reason: "killzone + consolidation" };
  return { cluster: null, direction: 0, reason: "no five-cluster confluence" };
}

// ─── END ICT/SMC + HMM ENGINE ─────────────────────────────────────────────────

export const guardrails = {
  volumeFilter: true,
  adxFilter: true,
  hardInvalidation: true,
  trailingStop: true,
  duplicatePositionCheck: true,
  paperOnly: true,
  entryZ: 2,
  exitZ: 0,
  invalidationZ: 3.5,
  maxPositionPct: 10,
  adxMax: 25,
  minVolumeRatio: 1,
};
type StrategyRules = typeof guardrails;

const DEFAULT_BACKTEST_DAYS = 180;
const DEFAULT_AUTOMATION_INTERVAL_SECONDS = 300;

// ─── PER-USER AGENT RUNTIME ──────────────────────────────────────────────────
// All mutable agent state (activity trail, audit runs, demo positions,
// trailing extremes, automation loop) is scoped per signed-in user instead of
// being module-level singletons, so users sharing one process cannot read or
// clobber each other's agent. The active user comes from the AsyncLocalStorage
// session set by withUserCredentials(); contexts without a session (local demo
// auth, tests) fall back to a shared demo runtime.
//
// Note: on Vercel serverless, in-process runtimes and timers do not survive
// across instances — durable cross-instance state belongs in PostgreSQL. This
// isolation targets long-running processes (self-host / Replit) and makes
// single-instance behavior correct for many users.

type AgentRuntimeState = {
  userId: string;
  lastRunAt: string | null;
  totalScans: number;
  signalsToday: number;
  blockedToday: number;
  activities: Activity[];
  auditRuns: AuditRun[];
  demoPositions: Map<string, Position>;
  trailingExtremes: Map<string, number>;
  automationTimer: ReturnType<typeof setTimeout> | null;
  automationRunning: boolean;
  automationIntervalSeconds: number;
  automationSymbols: string[];
  automationStartedAt: string | null;
  automationNextRunAt: string | null;
  automationLastError: string | null;
  automationCycleInFlight: boolean;
};

function createAgentRuntime(userId: string): AgentRuntimeState {
  return {
    userId,
    lastRunAt: null,
    totalScans: 0,
    signalsToday: 0,
    blockedToday: 0,
    activities: [],
    auditRuns: [],
    demoPositions: new Map(),
    trailingExtremes: new Map(),
    automationTimer: null,
    automationRunning: false,
    automationIntervalSeconds: DEFAULT_AUTOMATION_INTERVAL_SECONDS,
    automationSymbols: [...DEFAULT_SYMBOLS],
    automationStartedAt: null,
    automationNextRunAt: null,
    automationLastError: null,
    automationCycleInFlight: false,
  };
}

const agentRuntimes = new Map<string, AgentRuntimeState>();

/** Returns the mutable runtime bound to the current session user. */
function agentState(): AgentRuntimeState {
  const userId = currentUserId();
  let runtime = agentRuntimes.get(userId);
  if (!runtime) {
    runtime = createAgentRuntime(userId);
    agentRuntimes.set(userId, runtime);
  }
  return runtime;
}

/** Returns (creating if needed) the runtime for an explicit user id. */
function agentStateFor(userId: string): AgentRuntimeState {
  let runtime = agentRuntimes.get(userId);
  if (!runtime) {
    runtime = createAgentRuntime(userId);
    agentRuntimes.set(userId, runtime);
  }
  return runtime;
}

/** Test helper: clears per-user runtimes so each test starts fresh. */
export function _resetAgentRuntimesForTests(): void {
  agentRuntimes.clear();
}

function hasCredentials(): boolean {
  const credentials = getAlpacaCredentials();
  return Boolean(credentials.apiKey && credentials.apiSecret);
}

function mode(): "paper" | "demo" {
  return hasCredentials() ? "paper" : "demo";
}

function normalizedSymbols(symbols: string[]): string[] {
  return [
    ...new Set(
      symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean),
    ),
  ].slice(0, 8);
}

async function credentialsWork(): Promise<boolean> {
  if (!hasCredentials()) return false;
  try {
    await alpacaRequest<unknown>("/v2/account");
    return true;
  } catch {
    return false;
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values: number[]): number {
  return values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function calculateAdx(bars: Bar[], period = 14): number {
  if (bars.length < period + 2) return 18;
  const trueRanges: number[] = [];
  const plusMoves: number[] = [];
  const minusMoves: number[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const current = bars[index];
    const previous = bars[index - 1];
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
    const up = current.high - previous.high;
    const down = previous.low - current.low;
    plusMoves.push(up > down && up > 0 ? up : 0);
    minusMoves.push(down > up && down > 0 ? down : 0);
  }
  const dxValues: number[] = [];
  for (let index = period; index <= trueRanges.length; index += 1) {
    const tr = mean(trueRanges.slice(index - period, index));
    if (!tr) continue;
    const plus = (mean(plusMoves.slice(index - period, index)) / tr) * 100;
    const minus = (mean(minusMoves.slice(index - period, index)) / tr) * 100;
    dxValues.push(
      plus + minus === 0
        ? 0
        : (Math.abs(plus - minus) / (plus + minus)) * 100,
    );
  }
  return Math.min(60, Math.max(5, mean(dxValues.slice(-period)) || 18));
}

function demoBars(symbol: string): Bar[] {
  const seed = [...symbol].reduce((total, character) => total + character.charCodeAt(0), 0);
  const base = 85 + (seed % 155);
  return Array.from({ length: 60 }, (_, index) => {
    const cycle = Math.sin(index * 0.33 + seed) * 2.8;
    const pulse = Math.sin(index * 0.09 + seed * 0.3) * 0.8;
    const close = base + cycle + pulse + index * 0.02;
    const range = 0.7 + Math.abs(Math.sin(index + seed)) * 0.55;
    // Synthetic bars always cover the full indicator window (>= 22 closes for
    // the 20-bar SMA/ADX warm-up) so demo mode never reports "insufficient data".
    const open = index === 0 ? close : close - (cycle - Math.sin((index - 1) * 0.33 + seed) * 2.8);
    return {
      timestamp: new Date(Date.now() - (59 - index) * 86_400_000).toISOString(),
      open,
      close,
      high: close + range,
      low: close - range,
      volume: 900_000 + Math.round((Math.sin(index * 0.47 + seed) + 1) * 270_000),
    };
  });
}

const demoAssets = [
  ["SPY", "SPDR S&P 500 ETF Trust", "ARCA"],
  ["QQQ", "Invesco QQQ Trust", "NASDAQ"],
  ["IWM", "iShares Russell 2000 ETF", "ARCA"],
  ["AAPL", "Apple Inc.", "NASDAQ"],
  ["MSFT", "Microsoft Corporation", "NASDAQ"],
  ["NVDA", "NVIDIA Corporation", "NASDAQ"],
  ["TSLA", "Tesla, Inc.", "NASDAQ"],
  ["AMZN", "Amazon.com, Inc.", "NASDAQ"],
].map(([symbol, name, exchange]) => ({
  symbol,
  name,
  exchange,
  assetClass: "us_equity",
  status: "active",
  tradable: true,
  fractionable: true,
}));

async function alpacaRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${PAPER_TRADING_URL}${path}`, {
    ...init,
    headers: {
      "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
      "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Alpaca ${response.status}: ${message.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

async function fetchBarsWithFeed(
  symbol: string,
  timeframe: Timeframe,
  feed: DataFeed,
  limit: number,
  start?: string,
): Promise<Bar[]> {
  const query = new URLSearchParams({
    timeframe,
    limit: String(limit),
    feed,
    // With a lookback window, ask for the most recent bars first (desc) and
    // re-sort below; without one, keep the previous asc behaviour.
    sort: start ? "desc" : "asc",
  });
  if (start) query.set("start", start);
  const response = await fetch(
    `${MARKET_DATA_URL}/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
    {
      headers: {
        "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
        "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
      },
    },
  );
  if (!response.ok) {
    const message = await response.text();
    const error = new Error(`Market data ${response.status} (feed=${feed}): ${message.slice(0, 300)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as {
    bars?: Array<{ t?: string; o?: number; c: number; h: number; l: number; v: number }>;
  };
  const bars = (payload.bars ?? []).map((bar) => ({
    timestamp: bar.t,
    open: bar.o !== undefined ? toNumber(bar.o) : undefined,
    close: toNumber(bar.c),
    high: toNumber(bar.h),
    low: toNumber(bar.l),
    volume: toNumber(bar.v),
  }));
  return start ? bars.reverse() : bars;
}

/**
 * Fetch bars with feed fallback. The free plan's `iex` feed frequently
 * returns zero bars for illiquid names or outside market hours, which used
 * to surface as a bare "insufficient_data" regime with no explanation.
 * `feed=auto` now walks the fallback order and records every upstream failure
 * so diagnostics can show exactly why data is missing.
 */
async function fetchBars(
  symbol: string,
  timeframe: Timeframe = "1Day",
  feed: DataFeed | "auto" = "auto",
  limit = 60,
): Promise<Bar[]> {
  if (!hasCredentials()) return demoBars(symbol);
  const feedOrder: DataFeed[] = feed === "auto" ? ["iex", "sip", "delayed_sip"] : [feed];
  let lastError: unknown = null;
  for (const candidate of feedOrder) {
    try {
      const bars = await fetchBarsWithFeed(symbol, timeframe, candidate, limit);
      if (bars.length > 0) return bars;
      lastError = new Error(`feed=${candidate} returned zero bars`);
      recordMarketDataFailure(lastError, candidate);
    } catch (error) {
      lastError = error;
      recordMarketDataFailure(error, candidate);
    }
  }
  if (feed === "auto") return []; // scanners treat empty as honest "no data"
  throw lastError instanceof Error ? lastError : new Error("Market data unavailable");
}

/** Wire shape per the OpenAPI contract (OhlcvBar): the chart reads t/o/h/l/c/v. */
export interface WireBar {
  t: string | null;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function toWireBars(bars: Bar[]): WireBar[] {
  return bars.map((b) => ({
    t: b.timestamp ?? null,
    o: b.open ?? b.close,
    h: b.high,
    l: b.low,
    c: b.close,
    v: b.volume,
  }));
}

const LOOKBACK_DAYS: Record<"1D" | "5D" | "1M" | "3M" | "1Y", number> = {
  "1D": 1,
  "5D": 5,
  "1M": 30,
  "3M": 91,
  "1Y": 365,
};

export type BarsLookback = keyof typeof LOOKBACK_DAYS;

/** OHLCV chart data for the UI. Tries each feed until one returns bars. */
export async function getMarketBars(
  symbol: string,
  timeframe: Timeframe = "1Day",
  feed: DataFeed | "auto" = "auto",
  limit = 120,
  lookback?: BarsLookback,
): Promise<{ symbol: string; timeframe: string; feed: string; lookback?: string; bars: WireBar[] }> {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) throw new Error("Symbol is required.");
  const startIso = lookback
    ? new Date(Date.now() - LOOKBACK_DAYS[lookback] * 86_400_000).toISOString()
    : undefined;
  if (!hasCredentials()) {
    let demo = demoBars(normalized);
    if (startIso) demo = demo.filter((b) => (b.timestamp ?? "") >= startIso);
    return { symbol: normalized, timeframe, feed: "demo", ...(lookback ? { lookback } : {}), bars: toWireBars(demo).slice(-limit) };
  }
  const feedOrder: DataFeed[] = feed === "auto" ? ["iex", "sip", "delayed_sip"] : [feed];
  for (const candidate of feedOrder) {
    try {
      const bars = await fetchBarsWithFeed(normalized, timeframe, candidate, limit, startIso);
      if (bars.length > 0) {
        return { symbol: normalized, timeframe, feed: candidate, ...(lookback ? { lookback } : {}), bars: toWireBars(bars) };
      }
      recordMarketDataFailure(new Error(`feed=${candidate} returned zero bars`), candidate);
    } catch (error) {
      recordMarketDataFailure(error, candidate);
    }
  }
  return { symbol: normalized, timeframe, feed: "none", ...(lookback ? { lookback } : {}), bars: [] };
}

/**
 * Latest trade for a symbol from Alpaca's market data (v2/stocks/{symbol}/trades/latest).
 * The frontend polls this every few seconds for a live price — WebSocket
 * streaming is not viable on Vercel serverless, so this is the real-time
 * mechanism. `live: false` in demo mode (no real data source).
 */
export async function getLatestQuote(symbol: string) {
  const sym = symbol.trim().toUpperCase();
  if (!sym) throw new Error("Symbol is required.");
  if (!hasCredentials()) {
    const bars = demoBars(sym);
    return {
      symbol: sym,
      price: bars.at(-1)?.close ?? null,
      size: null,
      timestamp: new Date().toISOString(),
      feed: "demo",
      live: false,
    };
  }
  const response = await fetch(
    `${MARKET_DATA_URL}/stocks/${encodeURIComponent(sym)}/trades/latest`,
    {
      headers: {
        "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
        "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
      },
    },
  );
  if (!response.ok) {
    const message = await response.text();
    recordMarketDataFailure(new Error(`latest trade ${response.status}: ${message.slice(0, 200)}`), "latest");
    const error = new Error(`Market data ${response.status}: ${message.slice(0, 300)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as {
    trade?: { p?: number; s?: number; t?: string };
    symbol?: string;
  };
  const trade = payload.trade;
  return {
    symbol: sym,
    price: trade?.p ?? null,
    size: trade?.s ?? null,
    timestamp: trade?.t ?? null,
    feed: "latest",
    live: true,
  };
}

type OptionSnapshotRaw = {
  symbol?: string;
  greeks?: { delta?: number };
  latest_quote?: { bid?: number; ask?: number };
  latestQuote?: { bid?: number; ask?: number };
  latest_trade?: { p?: number };
  latestTrade?: { p?: number };
};

/**
 * Option chain snapshot (US equity/ETF options, OCC symbols) from Alpaca's
 * options market data. Available in the paper environment by default per
 * Alpaca's options-trading docs. Requires credentials.
 */
export async function getOptionChain(underlying: string) {
  if (!hasCredentials()) {
    throw new Error("Alpaca credentials are required to view option chains. Add them on the Credentials page.");
  }
  const sym = underlying.trim().toUpperCase();
  if (!sym) throw new Error("Underlying symbol is required.");
  // MARKET_DATA_URL ends in /v2 (stock data); options live under /v1beta1 on the same host.
  const optionsBase = new URL(MARKET_DATA_URL).origin;
  const response = await fetch(
    `${optionsBase}/v1beta1/options/snapshots/${encodeURIComponent(sym)}?limit=100`,
    {
      headers: {
        "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
        "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
      },
    },
  );
  if (!response.ok) {
    const message = await response.text();
    const error = new Error(`Options data ${response.status}: ${message.slice(0, 300)}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  const payload = (await response.json()) as {
    // Alpaca returns a map keyed by OCC symbol; tolerate an array shape too,
    // and both snake_case (latest_quote/greeks) and camelCase variants.
    snapshots?: Record<string, OptionSnapshotRaw> | OptionSnapshotRaw[];
  };
  // OCC format: UNDERLYING + YYMMDD + C/P + strike*1000 (8 digits)
  const occRe = /^([A-Z]+)(\d{6})([CP])(\d{8})$/;
  const raw = payload.snapshots;
  const entries: Array<{ symbol?: string } & OptionSnapshotRaw> = Array.isArray(raw)
    ? raw.filter((s): s is OptionSnapshotRaw => Boolean(s))
    : Object.entries(raw ?? {}).map(([occ, snap]) => ({ symbol: occ, ...snap }));
  const contracts = entries
    .map((snap) => {
      const occ = snap.symbol ?? "";
      const m = occRe.exec(occ);
      if (!m) return null;
      const yymmdd = m[2];
      const expiry = `20${yymmdd.slice(0, 2)}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
      return {
        occSymbol: occ,
        strike: Number(m[4]) / 1000,
        expiry,
        type: m[3] === "C" ? ("call" as const) : ("put" as const),
        bid: (snap.latest_quote ?? snap.latestQuote)?.bid ?? null,
        ask: (snap.latest_quote ?? snap.latestQuote)?.ask ?? null,
        openInterest: null,
        delta: snap.greeks?.delta ?? null,
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike);
  return { underlying: sym, count: contracts.length, contracts };
}

async function fetchHistoricalBars(
  symbol: string,
  start: string,
  end: string,
  timeframe: Timeframe = "1Day",
  feed: DataFeed = "iex",
): Promise<Bar[]> {
  if (!hasCredentials()) {
    throw new Error("Alpaca credentials are required for a historical backtest.");
  }
  const query = new URLSearchParams({
    timeframe,
    start,
    end,
    limit: "1000",
    feed,
    sort: "asc",
  });
  const response = await fetch(
    `${MARKET_DATA_URL}/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
    {
      headers: {
        "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
        "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
      },
    },
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Market data ${response.status}: ${message.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    bars?: Array<{ t: string; c: number; h: number; l: number; v: number }>;
  };
  return (payload.bars ?? []).map((bar) => ({
    timestamp: bar.t,
    close: toNumber(bar.c),
    high: toNumber(bar.h),
    low: toNumber(bar.l),
    volume: toNumber(bar.v),
  }));
}

async function fetchAccount(): Promise<{
  equity: number;
  cash: number;
  buyingPower: number;
  dayPnl: number;
  dayPnlPct: number;
  currency: string;
}> {
  if (!hasCredentials()) {
    return {
      equity: 100_000,
      cash: 100_000,
      buyingPower: 200_000,
      dayPnl: 184.42,
      dayPnlPct: 0.18,
      currency: "USD",
    };
  }
  const account = await alpacaRequest<{
    equity: string;
    cash: string;
    buying_power: string;
    last_equity: string;
    currency: string;
  }>("/v2/account");
  const equity = toNumber(account.equity);
  const lastEquity = toNumber(account.last_equity, equity);
  return {
    equity,
    cash: toNumber(account.cash),
    buyingPower: toNumber(account.buying_power),
    dayPnl: equity - lastEquity,
    dayPnlPct: lastEquity ? ((equity - lastEquity) / lastEquity) * 100 : 0,
    currency: account.currency || "USD",
  };
}

async function fetchPositions(): Promise<Position[]> {
  if (!hasCredentials()) return [...agentState().demoPositions.values()];
  const positions = await alpacaRequest<
    Array<{
      symbol: string;
      qty: string;
      side: string;
      avg_entry_price: string;
      current_price: string;
      market_value?: string;
      unrealized_pl: string;
    }>
  >("/v2/positions");
  return positions.map((position) => ({
    symbol: position.symbol,
    qty: Math.abs(toNumber(position.qty)),
    side: position.side === "short" ? "short" : "long",
    avgEntryPrice: toNumber(position.avg_entry_price),
    currentPrice: toNumber(position.current_price),
    marketValue: Math.abs(toNumber(position.market_value, toNumber(position.qty) * toNumber(position.current_price))),
    unrealizedPnl: toNumber(position.unrealized_pl),
  }));
}

export async function getAgentAssets(search?: string) {
  const query = search?.trim().toLowerCase();
  if (!hasCredentials()) {
    return GetAgentAssetsResponse.parse(
      demoAssets.filter((asset) => !query || `${asset.symbol} ${asset.name}`.toLowerCase().includes(query)),
    );
  }
  const assets = await alpacaRequest<
    Array<{
      symbol: string;
      name: string;
      exchange: string;
      class: string;
      status: string;
      tradable: boolean;
      fractionable: boolean;
    }>
  >("/v2/assets?status=active&tradable=true&asset_class=us_equity");
  return GetAgentAssetsResponse.parse(
    assets
      .filter((asset) => !query || `${asset.symbol} ${asset.name}`.toLowerCase().includes(query))
      .slice(0, 100)
      .map((asset) => ({
        symbol: asset.symbol,
        name: asset.name,
        exchange: asset.exchange,
        assetClass: asset.class,
        status: asset.status,
        tradable: asset.tradable,
        fractionable: asset.fractionable,
      })),
  );
}

async function fetchOrders() {
  if (!hasCredentials()) return [];
  const orders = await alpacaRequest<
    Array<{
      id: string;
      symbol: string;
      side: string;
      type: string;
      status: string;
      qty: string;
      filled_qty: string;
      submitted_at: string;
      filled_at?: string | null;
    }>
  >("/v2/orders?status=all&limit=50&direction=desc");
  return orders.map((order) => ({
    id: order.id,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    qty: toNumber(order.qty),
    filledQty: toNumber(order.filled_qty),
    submittedAt: order.submitted_at,
    filledAt: order.filled_at ?? null,
  }));
}

export async function getAgentAccount() {
  const [account, positions, orders] = await Promise.all([
    fetchAccount(),
    fetchPositions(),
    fetchOrders(),
  ]);
  return GetAgentAccountResponse.parse({
    account,
    positions: positions.map((position) => ({
      symbol: position.symbol,
      qty: position.qty,
      side: position.side,
      avgEntryPrice: position.avgEntryPrice,
      currentPrice: position.currentPrice,
      marketValue: position.marketValue,
      unrealizedPnl: position.unrealizedPnl,
    })),
    orders,
    fetchedAt: new Date().toISOString(),
  });
}

function positionFor(positions: Position[], symbol: string): Position | undefined {
  return positions.find((position) => position.symbol === symbol);
}

function snapshotFromBars(
  symbol: string,
  bars: Bar[],
  position: Position | undefined,
  extremes = agentState().trailingExtremes,
  rules: StrategyRules = guardrails,
  strategyMode: StrategyMode = "zscore",
): Snapshot {
  const closes = bars.map((bar) => bar.close);
  const window = closes.slice(-20);
  const sma = mean(window);
  const stddev = standardDeviation(window) || 0.01;
  const price = closes.at(-1) ?? 0;
  const zScore = (price - sma) / stddev;
  const volumes = bars.map((bar) => bar.volume);
  const avgVolume = mean(volumes.slice(-20));
  const volume = bars.at(-1)?.volume ?? 0;
  const volumeRatio = avgVolume ? volume / avgVolume : 0;
  const adx = calculateAdx(bars);
  const side = position?.side ?? "flat";
  const extreme = extremes.get(symbol);
  const nextExtreme =
    side === "long"
      ? Math.max(extreme ?? price, price)
      : side === "short"
        ? Math.min(extreme ?? price, price)
        : price;
  extremes.set(symbol, nextExtreme);

  let signal: Snapshot["signal"] = "hold";
  let tradeBlockedReason: string | null = null;
  if (position && Math.abs(zScore) >= rules.invalidationZ) {
    signal = "invalidation";
  } else if (
    position &&
    ((position.side === "long" && zScore >= rules.exitZ) ||
      (position.side === "short" && zScore <= rules.exitZ))
  ) {
    signal = "exit";
  } else if (
    position &&
    rules.trailingStop &&
    ((position.side === "long" && price <= nextExtreme * 0.98) ||
      (position.side === "short" && price >= nextExtreme * 1.02))
  ) {
    signal = "invalidation";
  } else if (!position && Math.abs(zScore) >= rules.entryZ) {
    if (adx > rules.adxMax) {
      signal = "blocked";
      tradeBlockedReason = `ADX ${adx.toFixed(1)} indicates a trending regime`;
    } else if (volumeRatio < rules.minVolumeRatio) {
      signal = "blocked";
      tradeBlockedReason = `Volume is ${Math.round(volumeRatio * 100)}% of its 20-day average`;
    } else {
      signal = zScore <= -rules.entryZ ? "long_entry" : "short_entry";
    }
  }

  // ICT/HMM overlay — compute cluster when mode is ict_hmm
  let cluster: string | null = null;
  let hmmRegime: string = bars.length < 22 ? "insufficient_data" : adx <= rules.adxMax ? "mean_reverting" : "trending";
  if (strategyMode === "ict_hmm" && bars.length >= 30) {
    const hmm = classifyRegimeHmm(bars);
    const smc = extractSmcFeatures(bars);
    const tmaSlope = tmaSlopeApprox(bars);
    const route = routeCluster(hmm.regime, hmm.awd, hmm.directionalBias, smc, tmaSlope);
    cluster = route.cluster;
    // Override signal using cluster direction when AWD gate passes
    if (!position && route.cluster && route.direction !== 0) {
      signal = route.direction === 1 ? "long_entry" : "short_entry";
      tradeBlockedReason = null;
    } else if (!position && !route.cluster && signal !== "hold") {
      signal = "blocked";
      tradeBlockedReason = route.reason;
    }
    hmmRegime =
      hmm.regime === "Expansion" ? "expansion" :
      hmm.regime === "Retracement" ? "retracement" :
      hmm.regime === "Consolidation" ? "consolidation" : "insufficient_data";
  }

  return GetMarketSnapshotResponse.parse({
    symbol,
    price,
    sma,
    stddev,
    zScore,
    adx,
    volume,
    avgVolume,
    volumeRatio,
    positionQty: position?.qty ?? 0,
    positionSide: side,
    unrealizedPnl: position?.unrealizedPnl ?? 0,
    signal,
    regime: hmmRegime,
    cluster,
    updatedAt: new Date().toISOString(),
    tradeBlockedReason,
  });
}

function addActivity(
  activity: Omit<Activity, "id">,
  auditExtra?: Omit<AuditRun, keyof Activity>,
): Activity {
  const state = agentState();
  const created = { id: randomUUID(), ...activity };
  state.activities = [created, ...state.activities].slice(0, 40);
  if (created.status === "blocked") state.blockedToday += 1;
  if (["submitted", "simulated", "closed"].includes(created.status)) state.signalsToday += 1;
  if (auditExtra) {
    const auditRecord: AuditRun = { ...created, ...auditExtra };
    state.auditRuns = [auditRecord, ...state.auditRuns].slice(0, 100);
  }
  return created;
}

export function getAuditRuns(): AuditRun[] {
  return agentState().auditRuns;
}

async function submitEntry(
  snapshot: Snapshot,
  equity: number,
  dryRun: boolean,
  rules: StrategyRules = guardrails,
  idempotencyKey?: string,
): Promise<{ side: string; qty: number; orderId: string | null; status: Activity["status"]; reason: string }> {
  checkIdempotency(idempotencyKey);
  const qty = Math.max(1, Math.floor((equity * (rules.maxPositionPct / 100)) / snapshot.price));
  const side = snapshot.signal === "long_entry" ? "buy" : "sell";
  let orderId: string | null = null;
  let status: Activity["status"] = "simulated";
  if (hasCredentials() && !dryRun) {
    const order = await alpacaRequest<{ id: string }>("/v2/orders", {
      method: "POST",
      body: JSON.stringify({
        symbol: snapshot.symbol,
        qty: String(qty),
        side,
        type: "market",
        time_in_force: "day",
        client_order_id: idempotencyKey ?? randomUUID(),
      }),
    });
    orderId = order.id;
    status = "submitted";
  } else if (!hasCredentials()) {
    agentState().demoPositions.set(snapshot.symbol, {
      symbol: snapshot.symbol,
      qty,
      side: side === "buy" ? "long" : "short",
      avgEntryPrice: snapshot.price,
      currentPrice: snapshot.price,
      marketValue: snapshot.price * qty,
      unrealizedPnl: 0,
    });
  }
  const reason = `Z-score ${snapshot.zScore.toFixed(2)} crossed the ${rules.entryZ.toFixed(1)}σ entry threshold; ADX and volume confirmed.`;
  return { side, qty, orderId, status, reason };
}

async function closePosition(
  snapshot: Snapshot,
  reason: string,
  status: Activity["status"],
): Promise<Activity> {
  let orderId: string | null = null;
  if (hasCredentials()) {
    const response = await fetch(
      `${PAPER_TRADING_URL}/v2/positions/${encodeURIComponent(snapshot.symbol)}`,
      {
        method: "DELETE",
        headers: {
          "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
          "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
        },
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Alpaca close ${response.status}: ${message.slice(0, 300)}`);
    }
  } else {
    agentState().demoPositions.delete(snapshot.symbol);
  }
  agentState().trailingExtremes.delete(snapshot.symbol);
  return addActivity({
    at: new Date().toISOString(),
    action: status === "closed" ? "EXIT TO EQUILIBRIUM" : "HARD INVALIDATION",
    symbol: snapshot.symbol,
    zScore: snapshot.zScore,
    reason,
    orderId,
    status,
  });
}

export async function getStatus() {
  const state = agentState();
  const connected = await credentialsWork();
  const paperUrlValid = PAPER_TRADING_URL.includes("paper-api.alpaca.markets");
  return {
    ...GetAgentStatusResponse.parse({
      mode: mode(),
      connected,
      paper: true,
      lastRunAt: state.lastRunAt,
      nextRunAt: state.automationRunning ? state.automationNextRunAt : null,
      running: state.automationRunning,
      intervalSeconds: state.automationIntervalSeconds,
      startedAt: state.automationStartedAt,
      lastError: state.automationLastError,
      symbols: state.automationSymbols,
      heartbeat: new Date().toISOString(),
      guardrails,
    }),
    paperUrlValid,
  };
}

function clearAutomationTimer(state: AgentRuntimeState) {
  if (state.automationTimer) {
    clearTimeout(state.automationTimer);
    state.automationTimer = null;
  }
  state.automationNextRunAt = null;
}

async function runAutomationCycle(state: AgentRuntimeState, log: Logger, strategyMode: StrategyMode = "zscore") {
  if (!state.automationRunning || state.automationCycleInFlight) return;
  state.automationCycleInFlight = true;
  try {
    // The timer callback runs outside any request, so re-enter this user's
    // session context (freshly reloaded credentials) before each cycle.
    await withUserCredentials(state.userId, () =>
      runStrategy(state.automationSymbols, false, log, guardrails, strategyMode),
    );
    state.automationLastError = null;
  } catch (error) {
    state.automationLastError =
      error instanceof Error ? error.message : "Strategy cycle failed";
    log.error({ err: error }, "Continuous strategy cycle failed");
  } finally {
    state.automationCycleInFlight = false;
  }
}

function scheduleAutomationCycle(state: AgentRuntimeState, log: Logger, strategyMode: StrategyMode = "zscore") {
  if (!state.automationRunning) return;
  const delay = state.automationIntervalSeconds * 1000;
  state.automationNextRunAt = new Date(Date.now() + delay).toISOString();
  state.automationTimer = setTimeout(async () => {
    state.automationTimer = null;
    if (!state.automationRunning) return;
    await runAutomationCycle(state, log, strategyMode);
    scheduleAutomationCycle(state, log, strategyMode);
  }, delay);
}

export async function startAgent(
  symbols: string[],
  intervalSeconds: number,
  log: Logger,
  strategyMode: StrategyMode = "zscore",
) {
  const state = agentState();
  const selectedSymbols = normalizedSymbols(symbols);
  if (!selectedSymbols.length) {
    throw new Error("At least one symbol is required to start the agent.");
  }

  clearAutomationTimer(state);
  state.automationSymbols = selectedSymbols;
  state.automationIntervalSeconds = intervalSeconds;
  state.automationStartedAt = new Date().toISOString();
  state.automationRunning = true;
  state.automationLastError = null;

  await runAutomationCycle(state, log, strategyMode);
  scheduleAutomationCycle(state, log, strategyMode);

  return StartAgentResponse.parse({
    running: state.automationRunning,
    mode: mode(),
    symbols: state.automationSymbols,
    intervalSeconds: state.automationIntervalSeconds,
    startedAt: state.automationStartedAt,
    lastRunAt: state.lastRunAt,
    nextRunAt: state.automationNextRunAt,
    lastError: state.automationLastError,
    message:
      mode() === "paper"
        ? `Agent started. Paper strategy cycles run every ${state.automationIntervalSeconds} seconds.`
        : "Agent started in demo mode. Add Alpaca paper credentials before relying on paper execution.",
  });
}

export function stopAgent(log: Logger) {
  const state = agentState();
  const wasRunning = state.automationRunning;
  state.automationRunning = false;
  clearAutomationTimer(state);
  state.automationStartedAt = null;
  log.info({ wasRunning }, "Continuous strategy agent stopped");

  return StopAgentResponse.parse({
    running: false,
    mode: mode(),
    symbols: state.automationSymbols,
    intervalSeconds: state.automationIntervalSeconds,
    startedAt: null,
    lastRunAt: state.lastRunAt,
    nextRunAt: null,
    lastError: state.automationLastError,
    message: wasRunning
      ? "Agent stopped. Existing paper positions were not changed."
      : "Agent is already stopped. Existing paper positions were not changed.",
  });
}

export async function getDashboard(log: Logger) {
  const state = agentState();
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    DEFAULT_SYMBOLS.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol));
    }),
  );
  const status = await getStatus();
  const realized = await getRealizedMetrics();
  return GetAgentDashboardResponse.parse({
    status,
    account,
    snapshots,
    activity: state.activities,
    metrics: {
      totalScans: state.totalScans,
      signalsToday: state.signalsToday,
      blockedToday: state.blockedToday,
      openPositions: positions.length,
      winRate: realized.winRate,
      avgHoldHours: realized.avgHoldHours,
      realizedTradeCount: realized.tradeCount,
      note: realized.note,
    },
  });
}

/**
 * Real win-rate / average-hold metrics computed from the account's actual
 * closed paper orders on Alpaca (filled buy+sell pairs per symbol, FIFO).
 * No placeholder numbers: when there is no realized history the callers get
 * zeros plus an explanatory note instead of invented values.
 */
async function getRealizedMetrics(): Promise<{
  winRate: number;
  avgHoldHours: number;
  tradeCount: number;
  note: string | null;
}> {
  if (!hasCredentials()) {
    return {
      winRate: 0,
      avgHoldHours: 0,
      tradeCount: 0,
      note: "Demo mode — no real Alpaca order history to compute win rate from.",
    };
  }
  try {
    const orders = await alpacaRequest<
      Array<{
        symbol: string;
        side: string;
        qty: string;
        filled_qty: string;
        filled_avg_price?: string | null;
        status: string;
        submitted_at?: string;
        filled_at?: string | null;
      }>
    >("/v2/orders?status=closed&limit=500&direction=desc");

    type Fill = { side: "buy" | "sell"; qty: number; price: number; at: number };
    const fillsBySymbol = new Map<string, Fill[]>();
    for (const order of orders) {
      const qty = toNumber(order.filled_qty);
      const price = toNumber(order.filled_avg_price, 0);
      if (order.status !== "filled" || qty <= 0 || price <= 0) continue;
      if (order.side !== "buy" && order.side !== "sell") continue;
      const at = Date.parse(order.filled_at ?? order.submitted_at ?? "");
      if (!Number.isFinite(at)) continue;
      const list = fillsBySymbol.get(order.symbol) ?? [];
      list.push({ side: order.side, qty, price, at });
      fillsBySymbol.set(order.symbol, list);
    }

    // FIFO round-trips: each sell closes the oldest open buy lot (long view).
    let wins = 0;
    let losses = 0;
    let holdHoursTotal = 0;
    for (const fills of fillsBySymbol.values()) {
      const chronological = [...fills].sort((a, b) => a.at - b.at);
      const openLots: Array<{ qty: number; price: number; at: number }> = [];
      for (const fill of chronological) {
        if (fill.side === "buy") {
          openLots.push({ qty: fill.qty, price: fill.price, at: fill.at });
          continue;
        }
        let remaining = fill.qty;
        while (remaining > 0 && openLots.length) {
          const lot = openLots[0];
          const matched = Math.min(lot.qty, remaining);
          const pnl = (fill.price - lot.price) * matched;
          if (pnl > 0) wins += 1;
          else losses += 1;
          holdHoursTotal += (fill.at - lot.at) / 3_600_000;
          lot.qty -= matched;
          remaining -= matched;
          if (lot.qty <= 0) openLots.shift();
        }
      }
    }

    const tradeCount = wins + losses;
    if (tradeCount === 0) {
      return {
        winRate: 0,
        avgHoldHours: 0,
        tradeCount: 0,
        note: "No closed round-trip trades yet — win rate fills in after your first completed paper trade.",
      };
    }
    return {
      winRate: (wins / tradeCount) * 100,
      avgHoldHours: holdHoursTotal / tradeCount,
      tradeCount,
      note: null,
    };
  } catch (error) {
    logger.warn({ err: error }, "Unable to compute realized metrics from Alpaca order history");
    return {
      winRate: 0,
      avgHoldHours: 0,
      tradeCount: 0,
      note: "Order history is temporarily unavailable — win rate will refresh automatically.",
    };
  }
}

/**
 * Ranked "safest trades right now": runs the live strategy over the default
 * universe and returns only candidates that pass every deterministic
 * guardrail, scored conservatively. Educational analysis only — no orders are
 * placed and nothing is stored.
 */
export async function getTradeSuggestions(strategyMode: StrategyMode = "zscore") {
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    DEFAULT_SYMBOLS.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol));
    }),
  );

  const scored = snapshots
    .filter(
      (snapshot): snapshot is typeof snapshot & { signal: "long_entry" | "short_entry" } =>
        snapshot.signal === "long_entry" || snapshot.signal === "short_entry",
    )
    .filter((snapshot) => !positionFor(positions, snapshot.symbol))
    .map((snapshot) => {
      const rationale: string[] = [];
      const warnings: string[] = [];
      let score = 0;

      const zExcess = Math.abs(snapshot.zScore) - guardrails.entryZ;
      if (zExcess >= 1) {
        score += 25;
        rationale.push(`Z-score ${snapshot.zScore.toFixed(2)}σ is far beyond the ±${guardrails.entryZ}σ entry threshold.`);
      } else if (zExcess >= 0.5) {
        score += 15;
        rationale.push(`Z-score ${snapshot.zScore.toFixed(2)}σ clears the ±${guardrails.entryZ}σ entry threshold with margin.`);
      } else {
        score += 8;
        rationale.push(`Z-score ${snapshot.zScore.toFixed(2)}σ just meets the ±${guardrails.entryZ}σ entry threshold.`);
        warnings.push("Entry signal is marginal — the deviation barely crosses the threshold.");
      }

      if (snapshot.adx <= guardrails.adxMax * 0.6) {
        score += 25;
        rationale.push(`ADX ${snapshot.adx.toFixed(1)} confirms a strongly non-trending regime — ideal for mean reversion.`);
      } else if (snapshot.adx <= guardrails.adxMax) {
        score += 15;
        rationale.push(`ADX ${snapshot.adx.toFixed(1)} is below the ${guardrails.adxMax} trend gate.`);
      }

      if (snapshot.volumeRatio >= guardrails.minVolumeRatio * 1.5) {
        score += 20;
        rationale.push(`Volume at ${snapshot.volumeRatio.toFixed(2)}× average strongly confirms the move.`);
      } else if (snapshot.volumeRatio >= guardrails.minVolumeRatio) {
        score += 12;
        rationale.push(`Volume at ${snapshot.volumeRatio.toFixed(2)}× average meets the confirmation gate.`);
      } else {
        warnings.push("Volume confirmation is weak.");
      }

      const roomToMean = Math.abs(snapshot.price - snapshot.sma) / Math.max(snapshot.sma, 1e-9);
      if (roomToMean >= 0.02) {
        score += 15;
        rationale.push(`Price sits ${ (roomToMean * 100).toFixed(2)}% from its 20-bar mean, leaving room for reversion before equilibrium.`);
      } else {
        warnings.push("Price is already close to the mean — limited reversion profit potential remains.");
      }

      const invalidationGap = guardrails.invalidationZ - Math.abs(snapshot.zScore);
      if (invalidationGap >= 1) {
        score += 15;
        rationale.push(`Hard-invalidation buffer is wide (|Z| is ${invalidationGap.toFixed(1)}σ below the ${guardrails.invalidationZ}σ limit).`);
      } else if (invalidationGap < 0.5) {
        warnings.push("Close to the 3.5σ hard-invalidation line — thesis dies quickly if the move extends.");
      }

      const side = snapshot.signal === "long_entry" ? "long" : "short";
      const positionUsd = account.equity * (guardrails.maxPositionPct / 100);
      const proposedQty = Math.max(1, Math.floor(positionUsd / snapshot.price));
      const stopLoss = side === "long" ? snapshot.price * 0.98 : snapshot.price * 1.02;
      const takeProfit = snapshot.sma;
      const safetyGrade = score >= 75 ? ("A" as const) : score >= 55 ? ("B" as const) : ("C" as const);

      return {
        symbol: snapshot.symbol,
        side,
        action: side === "long" ? ("BUY" as const) : ("SELL" as const),
        price: snapshot.price,
        zScore: snapshot.zScore,
        adx: snapshot.adx,
        volumeRatio: snapshot.volumeRatio,
        safetyScore: Math.min(100, score),
        safetyGrade,
        rationale,
        warnings,
        proposedQty,
        stopLoss,
        takeProfit,
        maxPositionPct: guardrails.maxPositionPct,
        regime: snapshot.regime ?? null,
        cluster: snapshot.cluster ?? null,
      };
    })
    .sort((a, b) => b.safetyScore - a.safetyScore);

  return {
    mode: mode(),
    strategyMode,
    scannedSymbols: DEFAULT_SYMBOLS,
    candidates: scored.length,
    suggestions: scored.slice(0, 5),
    disclaimer:
      "Educational analysis from deterministic rules on live Alpaca market data. Not financial advice. Paper trading only — no real money. Every trade remains subject to all six guardrails at execution time.",
    ranAt: new Date().toISOString(),
  };
}

export async function runStrategy(
  symbols: string[],
  dryRun: boolean,
  log: Logger,
  rules: StrategyRules = guardrails,
  strategyMode: StrategyMode = "zscore",
  idempotencyKey?: string,
) {
  const runId = randomUUID();
  const runStart = Date.now();
  const selectedSymbols = normalizedSymbols(symbols);
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    selectedSymbols.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(
        symbol,
        bars,
        positionFor(positions, symbol),
        agentState().trailingExtremes,
        rules,
        strategyMode,
      );
    }),
  );
  const actions: Activity[] = [];
  for (const snapshot of snapshots) {
    const position = positionFor(positions, snapshot.symbol);
    const stepStart = Date.now();
    const marketSnapshot = { symbol: snapshot.symbol, price: snapshot.price, zScore: snapshot.zScore, adx: snapshot.adx, volumeRatio: snapshot.volumeRatio, regime: snapshot.regime, cluster: snapshot.cluster };
    if (snapshot.signal === "long_entry" || snapshot.signal === "short_entry") {
      if (position) {
        actions.push(
          addActivity({
            at: new Date().toISOString(),
            action: "DUPLICATE POSITION BLOCKED",
            symbol: snapshot.symbol,
            zScore: snapshot.zScore,
            reason: "An open position already exists; the inventory check prevented stacking risk.",
            orderId: null,
            status: "blocked",
          }, { runId, latencyMs: Date.now() - stepStart, modelName: strategyMode === "ict_hmm" ? "ICT/HMM-5cluster" : "ZScore-ADX", outcome: "BLOCKED_BY_RISK", marketSnapshot, modelOutput: { signal: snapshot.signal, zScore: snapshot.zScore, cluster: snapshot.cluster }, riskValidatorResult: { rule: "duplicate_position", passed: false }, alpacaResponse: null }),
        );
      } else {
        const entry = await submitEntry(snapshot, account.equity, dryRun, rules, idempotencyKey);
        actions.push(
          addActivity({
            at: new Date().toISOString(),
            action: entry.side === "buy" ? "LONG ENTRY" : "SHORT ENTRY",
            symbol: snapshot.symbol,
            zScore: snapshot.zScore,
            reason: entry.reason,
            orderId: entry.orderId,
            status: entry.status,
          }, { runId, latencyMs: Date.now() - stepStart, modelName: strategyMode === "ict_hmm" ? "ICT/HMM-5cluster" : "ZScore-ADX", outcome: "EXECUTED", marketSnapshot, modelOutput: { signal: snapshot.signal, zScore: snapshot.zScore, cluster: snapshot.cluster }, riskValidatorResult: { volumeFilter: rules.volumeFilter, adxFilter: rules.adxFilter, passed: true }, alpacaResponse: entry.orderId ? { orderId: entry.orderId } : null }),
        );
      }
    } else if (snapshot.signal === "exit") {
      if (position) {
        const act = await closePosition(
          snapshot,
          `Z-score ${snapshot.zScore.toFixed(2)} crossed back through equilibrium.`,
          "closed",
        );
        actions.push(act);
      }
    } else if (snapshot.signal === "invalidation" && position) {
      const act = await closePosition(
        snapshot,
        `Risk invalidated at Z-score ${snapshot.zScore.toFixed(2)} or trailing-stop breach.`,
        "blocked",
      );
      actions.push(act);
    } else if (snapshot.signal === "blocked") {
      actions.push(
        addActivity({
          at: new Date().toISOString(),
          action: "ENTRY BLOCKED",
          symbol: snapshot.symbol,
          zScore: snapshot.zScore,
          reason: snapshot.tradeBlockedReason ?? "A strategy guardrail blocked this entry.",
          orderId: null,
          status: "blocked",
        }, { runId, latencyMs: Date.now() - stepStart, modelName: strategyMode === "ict_hmm" ? "ICT/HMM-5cluster" : "ZScore-ADX", outcome: "BLOCKED_BY_RISK", marketSnapshot, modelOutput: { signal: snapshot.signal, zScore: snapshot.zScore, cluster: snapshot.cluster }, riskValidatorResult: { reason: snapshot.tradeBlockedReason }, alpacaResponse: null }),
      );
    } else {
      addActivity({
        at: new Date().toISOString(),
        action: "HOLD",
        symbol: snapshot.symbol,
        zScore: snapshot.zScore,
        reason: snapshot.tradeBlockedReason ?? "No signal threshold crossed.",
        orderId: null,
        status: "simulated",
      }, { runId, latencyMs: Date.now() - stepStart, modelName: strategyMode === "ict_hmm" ? "ICT/HMM-5cluster" : "ZScore-ADX", outcome: "NEUTRAL_SIGNAL", marketSnapshot, modelOutput: { signal: snapshot.signal, zScore: snapshot.zScore }, riskValidatorResult: {}, alpacaResponse: null });
    }
  }
  const state = agentState();
  state.lastRunAt = new Date().toISOString();
  state.totalScans += 1;
  log.info({ mode: mode(), evaluated: snapshots.length, dryRun, strategyMode }, "Strategy scan completed");
  return RunStrategyResponse.parse({
    ranAt: state.lastRunAt,
    mode: mode(),
    evaluated: snapshots.length,
    actions,
    snapshots,
  });
}

export async function placeManualTrade(
  symbol: string,
  side: "buy" | "sell",
  qty: number,
  orderType: "market" | "limit" | "option",
  limitPrice: number | null | undefined,
  idempotencyKey: string | null | undefined,
  optionSymbol?: string | null | undefined,
) {
  const sym = symbol.trim().toUpperCase();
  checkIdempotency(idempotencyKey ?? undefined);
  let orderId: string | null = null;
  let status: "submitted" | "simulated" = "simulated";
  if (hasCredentials()) {
    // Options orders target the OCC contract directly and always require a
    // limit price per Alpaca's options-trading API.
    if (orderType === "option") {
      const occ = (optionSymbol ?? (sym.includes("C") || sym.includes("P") ? sym : "")).trim().toUpperCase();
      if (!occ || !/^([A-Z]+)(\d{6})([CP])(\d{8})$/.test(occ)) {
        throw new Error("A valid OCC option symbol (e.g. SPY250919C00500000) is required for an options order.");
      }
      if (limitPrice == null) {
        throw new Error("Options orders require a limit price — Alpaca does not accept market orders for options.");
      }
      const order = await alpacaRequest<{ id: string }>("/v2/orders", {
        method: "POST",
        body: JSON.stringify({
          symbol: occ,
          qty: String(qty),
          side,
          type: "limit",
          time_in_force: "day",
          limit_price: String(limitPrice),
          client_order_id: idempotencyKey ?? randomUUID(),
        }),
      });
      orderId = order.id;
      status = "submitted";
    } else {
    const body: Record<string, string> = {
      symbol: sym,
      qty: String(qty),
      side,
      type: orderType,
      time_in_force: "day",
      client_order_id: idempotencyKey ?? randomUUID(),
    };
    if (orderType === "limit" && limitPrice != null) {
      body["limit_price"] = String(limitPrice);
    }
    const order = await alpacaRequest<{ id: string }>("/v2/orders", {
      method: "POST",
      body: JSON.stringify(body),
    });
    orderId = order.id;
    status = "submitted";
    }
  } else {
    // demo mode — update in-memory position
    const bars = demoBars(sym);
    const price = bars.at(-1)?.close ?? 100;
    if (side === "buy") {
      agentState().demoPositions.set(sym, {
        symbol: sym,
        qty,
        side: "long",
        avgEntryPrice: price,
        currentPrice: price,
        marketValue: price * qty,
        unrealizedPnl: 0,
      });
    } else {
      agentState().demoPositions.delete(sym);
    }
  }
  const submittedAt = new Date().toISOString();
  addActivity({
    at: submittedAt,
    action: side === "buy" ? "MANUAL BUY" : "MANUAL SELL",
    symbol: sym,
    zScore: 0,
    reason: `Manual ${orderType} order · ${qty} share${qty === 1 ? "" : "s"} ${side === "buy" ? "bought" : "sold"}.`,
    orderId,
    status,
  });
  return PlaceManualTradeResponse.parse({
    orderId,
    symbol: sym,
    side,
    qty,
    orderType,
    status,
    mode: mode(),
    submittedAt,
    message: status === "submitted"
      ? `Paper ${orderType} order submitted to Alpaca · ${qty} × ${sym} ${side.toUpperCase()}`
      : `Demo ${orderType} order simulated · ${qty} × ${sym} ${side.toUpperCase()}`,
  });
}

export async function flattenPositions(log: Logger) {
  const positions = await fetchPositions();
  let closed = 0;
  if (hasCredentials()) {
    if (positions.length) {
      const response = await fetch(`${PAPER_TRADING_URL}/v2/positions`, {
        method: "DELETE",
        headers: {
          "APCA-API-KEY-ID": getAlpacaCredentials().apiKey,
          "APCA-API-SECRET-KEY": getAlpacaCredentials().apiSecret,
        },
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`Alpaca flatten ${response.status}: ${message.slice(0, 300)}`);
      }
      closed = positions.length;
    }
  } else {
    closed = agentState().demoPositions.size;
    agentState().demoPositions.clear();
  }
  agentState().trailingExtremes.clear();
  log.warn({ closed, mode: mode() }, "Paper positions flattened");
  return FlattenAgentPositionsResponse.parse({
    closed,
    mode: mode(),
    at: new Date().toISOString(),
    message: closed ? `Closed ${closed} paper position${closed === 1 ? "" : "s"}.` : "No open paper positions to close.",
  });
}

export async function getMarketSnapshot(symbol: string) {
  const normalized = symbol.trim().toUpperCase();
  if (!normalized) return null;
  const positions = await fetchPositions();
  const bars = await fetchBars(normalized);
  return snapshotFromBars(normalized, bars, positionFor(positions, normalized));
}

type BacktestPosition = {
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
  entryAt: string;
};

function markToMarket(capital: number, position: BacktestPosition | null, price: number) {
  if (!position) return capital;
  const unrealized =
    position.side === "long"
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;
  return capital + unrealized;
}

export async function runBacktest(
  symbols: string[],
  start: string,
  end: string,
  initialCapital: number,
  log: Logger,
  rules: StrategyRules = guardrails,
  historicalOverride?: Array<{ symbol: string; bars: Bar[] }>,
  timeframe: Timeframe = "1Day",
  feed: DataFeed = "iex",
  strategyMode: StrategyMode = "zscore",
) {
  if (!hasCredentials()) {
    throw new Error("Alpaca credentials are required for a historical backtest.");
  }

  const selectedSymbols = [
    ...new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 8);
  if (!selectedSymbols.length) {
    throw new Error("At least one symbol is required for a backtest.");
  }

  const historical =
    historicalOverride ??
    (await Promise.all(
      selectedSymbols.map(async (symbol) => ({
        symbol,
          bars: await fetchHistoricalBars(symbol, start, end, timeframe, feed),
      })),
    ));
  const usable = historical.filter(({ bars }) => bars.length >= 22);
  if (!usable.length) {
    throw new Error("Alpaca returned fewer than 22 daily bars for the selected range.");
  }

  const allocation = initialCapital / usable.length;
  const states = new Map<
    string,
    {
      capital: number;
      position: BacktestPosition | null;
      extremes: Map<string, number>;
      firstPrice: number;
      lastPrice: number;
    }
  >();
  const trades: Array<{
    symbol: string;
    side: "long" | "short";
    entryAt: string;
    exitAt: string;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    pnl: number;
    returnPct: number;
    exitReason: string;
  }> = [];
  let barsLoaded = 0;
  let signals = 0;
  const equityCurve: number[] = [initialCapital];

  for (const { symbol, bars } of usable) {
    states.set(symbol, {
      capital: allocation,
      position: null,
      extremes: new Map(),
      firstPrice: bars[0].close,
      lastPrice: bars.at(-1)?.close ?? bars[0].close,
    });
    barsLoaded += bars.length;
  }

  const maxBars = Math.max(...usable.map(({ bars }) => bars.length));
  for (let index = 21; index < maxBars; index += 1) {
    for (const { symbol, bars } of usable) {
      const state = states.get(symbol);
      if (!state || !bars[index]) continue;
      const history = bars.slice(0, index + 1);
      const price = bars[index].close;
      const snapshot = snapshotFromBars(
        symbol,
        history,
        state.position
          ? {
              symbol,
              qty: state.position.quantity,
              side: state.position.side,
              avgEntryPrice: state.position.entryPrice,
              currentPrice: price,
              marketValue: state.position.quantity * price,
              unrealizedPnl:
                state.position.side === "long"
                  ? (price - state.position.entryPrice) * state.position.quantity
                  : (state.position.entryPrice - price) * state.position.quantity,
            }
          : undefined,
        state.extremes,
        rules,
        strategyMode,
      );
      state.lastPrice = price;
      const barAt = (bars[index].timestamp ?? end).slice(0, 10);

      if (
        state.position &&
        (snapshot.signal === "exit" || snapshot.signal === "invalidation")
      ) {
        const position = state.position;
        const pnl =
          position.side === "long"
            ? (price - position.entryPrice) * position.quantity
            : (position.entryPrice - price) * position.quantity;
        const notional = position.entryPrice * position.quantity;
        state.capital += pnl;
        trades.push({
          symbol,
          side: position.side,
          entryAt: position.entryAt,
          exitAt: barAt,
          entryPrice: position.entryPrice,
          exitPrice: price,
          quantity: position.quantity,
          pnl,
          returnPct: notional ? (pnl / notional) * 100 : 0,
          exitReason: snapshot.signal === "exit" ? "equilibrium exit" : "risk invalidation",
        });
        state.position = null;
        state.extremes.clear();
      } else if (
        !state.position &&
        (snapshot.signal === "long_entry" || snapshot.signal === "short_entry")
      ) {
        const quantity = Math.floor(
          (state.capital * (rules.maxPositionPct / 100)) / price,
        );
        if (quantity > 0) {
          state.position = {
            side: snapshot.signal === "long_entry" ? "long" : "short",
            quantity,
            entryPrice: price,
            entryAt: barAt,
          };
          signals += 1;
        }
      }
    }

    const equity = [...states.values()].reduce((sum, state) => {
      return sum + markToMarket(state.capital, state.position, state.lastPrice);
    }, 0);
    equityCurve.push(equity);
  }

  for (const { symbol, bars } of usable) {
    const state = states.get(symbol);
    const finalBar = bars.at(-1);
    if (!state || !state.position || !finalBar) continue;
    const position = state.position;
    const pnl =
      position.side === "long"
        ? (finalBar.close - position.entryPrice) * position.quantity
        : (position.entryPrice - finalBar.close) * position.quantity;
    const notional = position.entryPrice * position.quantity;
    state.capital += pnl;
    trades.push({
      symbol,
      side: position.side,
      entryAt: position.entryAt,
      exitAt: (finalBar.timestamp ?? end).slice(0, 10),
      entryPrice: position.entryPrice,
      exitPrice: finalBar.close,
      quantity: position.quantity,
      pnl,
      returnPct: notional ? (pnl / notional) * 100 : 0,
      exitReason: "end of test",
    });
    state.position = null;
  }

  const finalEquity = [...states.values()].reduce(
    (sum, state) => sum + state.capital,
    0,
  );
  let peak = equityCurve[0] ?? initialCapital;
  let maxDrawdownPct = 0;
  for (const equity of equityCurve) {
    peak = Math.max(peak, equity);
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - equity) / peak) * 100);
    }
  }
  const winningTrades = trades.filter((trade) => trade.pnl > 0).length;
  const losingTrades = trades.filter((trade) => trade.pnl <= 0).length;
  const benchmarkReturnPct =
    usable.reduce(
      (sum, { bars }) =>
        sum +
        (((bars.at(-1)?.close ?? 0) / (bars[0]?.close ?? 1) - 1) * 100) /
          usable.length,
      0,
    );
  const ranAt = new Date().toISOString();

  log.info(
    {
      symbols: usable.map(({ symbol }) => symbol),
      barsLoaded,
      trades: trades.length,
      signals,
      strategyMode,
      returnPct: ((finalEquity - initialCapital) / initialCapital) * 100,
    },
    "Historical backtest completed",
  );

  return RunBacktestResponse.parse({
    mode: "paper",
    timeframe,
    feed,
    symbols: usable.map(({ symbol }) => symbol),
    start,
    end,
    barsLoaded,
    initialCapital,
    finalEquity,
    netPnl: finalEquity - initialCapital,
    returnPct: ((finalEquity - initialCapital) / initialCapital) * 100,
    maxDrawdownPct,
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate: trades.length ? (winningTrades / trades.length) * 100 : 0,
    benchmarkReturnPct,
    trades: trades.slice(-100),
    ranAt,
  });
}

export async function optimizeBacktest(
  symbols: string[],
  start: string,
  end: string,
  initialCapital: number,
  log: Logger,
  timeframe: Timeframe = "1Day",
  feed: DataFeed = "iex",
) {
  if (!hasCredentials()) {
    throw new Error("Alpaca credentials are required to optimize the strategy.");
  }

  const selectedSymbols = [
    ...new Set(
      symbols
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 8);
  const historical = await Promise.all(
    selectedSymbols.map(async (symbol) => ({
      symbol,
      bars: await fetchHistoricalBars(symbol, start, end, timeframe, feed),
    })),
  );
  const baseline = await runBacktest(
    selectedSymbols,
    start,
    end,
    initialCapital,
    log,
    guardrails,
    historical,
    timeframe,
    feed,
  );
  const entryZValues = [1.25, 1.5, 1.75, 2, 2.25, 2.5];
  const adxMaxValues = [15, 20, 25, 30];
  const volumeRatioValues = [0.8, 1, 1.2];
  const OPTIMIZE_DEADLINE = Date.now() + 50_000; // 50 s — stay inside Vercel 60 s limit
  const candidates: Array<{
    settings: {
      entryZ: number;
      adxMax: number;
      minVolumeRatio: number;
    };
    score: number;
    returnPct: number;
    maxDrawdownPct: number;
    totalTrades: number;
    winRate: number;
    result: Awaited<ReturnType<typeof runBacktest>>;
  }> = [];

  for (const entryZ of entryZValues) {
    for (const adxMax of adxMaxValues) {
      for (const minVolumeRatio of volumeRatioValues) {
        const settings = { entryZ, adxMax, minVolumeRatio };
        if (Date.now() > OPTIMIZE_DEADLINE) break;
        const result = await runBacktest(
          selectedSymbols,
          start,
          end,
          initialCapital,
          log,
          { ...guardrails, ...settings },
          historical,
          timeframe,
          feed,
        );
        candidates.push({
          settings,
          score: result.returnPct - result.maxDrawdownPct * 0.5,
          returnPct: result.returnPct,
          maxDrawdownPct: result.maxDrawdownPct,
          totalTrades: result.totalTrades,
          winRate: result.winRate,
          result,
        });
      }
      if (Date.now() > OPTIMIZE_DEADLINE) break;
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  const winner = candidates[0];
  if (!winner) throw new Error("No optimization candidates were evaluated.");
  const ranAt = new Date().toISOString();
  log.info(
    {
      candidatesTested: candidates.length,
      bestSettings: winner.settings,
      baselineReturnPct: baseline.returnPct,
      bestReturnPct: winner.returnPct,
    },
    "Strategy optimization completed",
  );

  return OptimizeBacktestResponse.parse({
    mode: "paper",
    timeframe,
    feed,
    symbols: baseline.symbols,
    start,
    end,
    initialCapital,
    candidatesTested: candidates.length,
    baseline,
    best: winner.result,
    bestSettings: winner.settings,
    leaderboard: candidates.slice(0, 10).map(({ result, ...candidate }) => candidate),
    ranAt,
  });
}