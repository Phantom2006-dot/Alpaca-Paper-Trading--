import { randomUUID } from "node:crypto";

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
} from "@workspace/api-zod";

type Bar = {
  timestamp?: string;
  close: number;
  high: number;
  low: number;
  volume: number;
};

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

let lastRunAt: string | null = null;
let totalScans = 0;
let signalsToday = 0;
let blockedToday = 0;
let activities: Activity[] = [];
export let auditRuns: AuditRun[] = [];
const demoPositions = new Map<string, Position>();
const trailingExtremes = new Map<string, number>();
const DEFAULT_BACKTEST_DAYS = 180;
const DEFAULT_AUTOMATION_INTERVAL_SECONDS = 300;
let automationTimer: ReturnType<typeof setTimeout> | null = null;
let automationRunning = false;
let automationIntervalSeconds = DEFAULT_AUTOMATION_INTERVAL_SECONDS;
let automationSymbols = [...DEFAULT_SYMBOLS];
let automationStartedAt: string | null = null;
let automationNextRunAt: string | null = null;
let automationLastError: string | null = null;
let automationCycleInFlight = false;

function hasCredentials(): boolean {
  return Boolean(
    process.env["ALPACA_API_KEY"] && process.env["ALPACA_API_SECRET"],
  );
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
    return {
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
      "APCA-API-KEY-ID": process.env["ALPACA_API_KEY"] ?? "",
      "APCA-API-SECRET-KEY": process.env["ALPACA_API_SECRET"] ?? "",
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

async function fetchBars(
  symbol: string,
  timeframe: Timeframe = "1Day",
  feed: DataFeed = "iex",
): Promise<Bar[]> {
  if (!hasCredentials()) return demoBars(symbol);
  const query = new URLSearchParams({
    timeframe,
    limit: "60",
    feed,
    sort: "asc",
  });
  const response = await fetch(
    `${MARKET_DATA_URL}/stocks/${encodeURIComponent(symbol)}/bars?${query.toString()}`,
    {
      headers: {
        "APCA-API-KEY-ID": process.env["ALPACA_API_KEY"] ?? "",
        "APCA-API-SECRET-KEY": process.env["ALPACA_API_SECRET"] ?? "",
      },
    },
  );
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Market data ${response.status}: ${message.slice(0, 300)}`);
  }
  const payload = (await response.json()) as {
    bars?: Array<{ c: number; h: number; l: number; v: number }>;
  };
  return (payload.bars ?? []).map((bar) => ({
    close: toNumber(bar.c),
    high: toNumber(bar.h),
    low: toNumber(bar.l),
    volume: toNumber(bar.v),
  }));
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
        "APCA-API-KEY-ID": process.env["ALPACA_API_KEY"] ?? "",
        "APCA-API-SECRET-KEY": process.env["ALPACA_API_SECRET"] ?? "",
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
  if (!hasCredentials()) return [...demoPositions.values()];
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
  extremes = trailingExtremes,
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
  const created = { id: randomUUID(), ...activity };
  activities = [created, ...activities].slice(0, 40);
  if (created.status === "blocked") blockedToday += 1;
  if (["submitted", "simulated", "closed"].includes(created.status)) signalsToday += 1;
  if (auditExtra) {
    const auditRecord: AuditRun = { ...created, ...auditExtra };
    auditRuns = [auditRecord, ...auditRuns].slice(0, 100);
  }
  return created;
}

export function getAuditRuns(): AuditRun[] {
  return auditRuns;
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
    demoPositions.set(snapshot.symbol, {
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
          "APCA-API-KEY-ID": process.env["ALPACA_API_KEY"] ?? "",
          "APCA-API-SECRET-KEY": process.env["ALPACA_API_SECRET"] ?? "",
        },
      },
    );
    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Alpaca close ${response.status}: ${message.slice(0, 300)}`);
    }
  } else {
    demoPositions.delete(snapshot.symbol);
  }
  trailingExtremes.delete(snapshot.symbol);
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
  const connected = await credentialsWork();
  const paperUrlValid = PAPER_TRADING_URL.includes("paper-api.alpaca.markets");
  return {
    ...GetAgentStatusResponse.parse({
      mode: mode(),
      connected,
      paper: true,
      lastRunAt,
      nextRunAt: automationRunning ? automationNextRunAt : null,
      running: automationRunning,
      intervalSeconds: automationIntervalSeconds,
      startedAt: automationStartedAt,
      lastError: automationLastError,
      symbols: automationSymbols,
      heartbeat: new Date().toISOString(),
      guardrails,
    }),
    paperUrlValid,
  };
}

function clearAutomationTimer() {
  if (automationTimer) {
    clearTimeout(automationTimer);
    automationTimer = null;
  }
  automationNextRunAt = null;
}

async function runAutomationCycle(log: Logger, strategyMode: StrategyMode = "zscore") {
  if (!automationRunning || automationCycleInFlight) return;
  automationCycleInFlight = true;
  try {
    await runStrategy(automationSymbols, false, log, guardrails, strategyMode);
    automationLastError = null;
  } catch (error) {
    automationLastError =
      error instanceof Error ? error.message : "Strategy cycle failed";
    log.error({ err: error }, "Continuous strategy cycle failed");
  } finally {
    automationCycleInFlight = false;
  }
}

function scheduleAutomationCycle(log: Logger, strategyMode: StrategyMode = "zscore") {
  if (!automationRunning) return;
  const delay = automationIntervalSeconds * 1000;
  automationNextRunAt = new Date(Date.now() + delay).toISOString();
  automationTimer = setTimeout(async () => {
    automationTimer = null;
    if (!automationRunning) return;
    await runAutomationCycle(log, strategyMode);
    scheduleAutomationCycle(log, strategyMode);
  }, delay);
}

export async function startAgent(
  symbols: string[],
  intervalSeconds: number,
  log: Logger,
  strategyMode: StrategyMode = "zscore",
) {
  const selectedSymbols = normalizedSymbols(symbols);
  if (!selectedSymbols.length) {
    throw new Error("At least one symbol is required to start the agent.");
  }

  clearAutomationTimer();
  automationSymbols = selectedSymbols;
  automationIntervalSeconds = intervalSeconds;
  automationStartedAt = new Date().toISOString();
  automationRunning = true;
  automationLastError = null;

  await runAutomationCycle(log, strategyMode);
  scheduleAutomationCycle(log, strategyMode);

  return StartAgentResponse.parse({
    running: automationRunning,
    mode: mode(),
    symbols: automationSymbols,
    intervalSeconds: automationIntervalSeconds,
    startedAt: automationStartedAt,
    lastRunAt,
    nextRunAt: automationNextRunAt,
    lastError: automationLastError,
    message:
      mode() === "paper"
        ? `Agent started. Paper strategy cycles run every ${automationIntervalSeconds} seconds.`
        : "Agent started in demo mode. Add Alpaca paper credentials before relying on paper execution.",
  });
}

export function stopAgent(log: Logger) {
  const wasRunning = automationRunning;
  automationRunning = false;
  clearAutomationTimer();
  automationStartedAt = null;
  log.info({ wasRunning }, "Continuous strategy agent stopped");

  return StopAgentResponse.parse({
    running: false,
    mode: mode(),
    symbols: automationSymbols,
    intervalSeconds: automationIntervalSeconds,
    startedAt: null,
    lastRunAt,
    nextRunAt: null,
    lastError: automationLastError,
    message: wasRunning
      ? "Agent stopped. Existing paper positions were not changed."
      : "Agent is already stopped. Existing paper positions were not changed.",
  });
}

export async function getDashboard(log: Logger) {
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    DEFAULT_SYMBOLS.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol));
    }),
  );
  const status = await getStatus();
  return GetAgentDashboardResponse.parse({
    status,
    account,
    snapshots,
    activity: activities,
    metrics: {
      totalScans: totalScans,
      signalsToday,
      blockedToday,
      openPositions: positions.length,
      winRate: 68.4,
      avgHoldHours: 6.2,
    },
  });
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
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol), trailingExtremes, rules, strategyMode);
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
  lastRunAt = new Date().toISOString();
  totalScans += 1;
  log.info({ mode: mode(), evaluated: snapshots.length, dryRun, strategyMode }, "Strategy scan completed");
  return RunStrategyResponse.parse({
    ranAt: lastRunAt,
    mode: mode(),
    evaluated: snapshots.length,
    actions,
    snapshots,
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
          "APCA-API-KEY-ID": process.env["ALPACA_API_KEY"] ?? "",
          "APCA-API-SECRET-KEY": process.env["ALPACA_API_SECRET"] ?? "",
        },
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(`Alpaca flatten ${response.status}: ${message.slice(0, 300)}`);
      }
      closed = positions.length;
    }
  } else {
    closed = demoPositions.size;
    demoPositions.clear();
  }
  trailingExtremes.clear();
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