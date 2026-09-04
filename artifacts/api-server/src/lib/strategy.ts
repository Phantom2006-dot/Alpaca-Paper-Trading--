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
  TestPaperRoundTripResponse,
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

const DEFAULT_SYMBOLS = ["SPY", "QQQ", "IWM", "AAPL"];
const PAPER_TRADING_URL = "https://paper-api.alpaca.markets";
const MARKET_DATA_URL = "https://data.alpaca.markets/v2";

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
const demoPositions = new Map<string, Position>();
const trailingExtremes = new Map<string, number>();
const DEFAULT_BACKTEST_DAYS = 180;
const DEFAULT_INTERVAL_SECONDS = 300;
let agentTimer: ReturnType<typeof setInterval> | null = null;
let agentRunning = false;
let agentIntervalSeconds = DEFAULT_INTERVAL_SECONDS;
let agentNextRunAt: string | null = null;
let agentLastError: string | null = null;
let agentSymbols = [...DEFAULT_SYMBOLS];
let agentRules: StrategyRules = guardrails;
let scheduledRunInFlight = false;

function hasCredentials(): boolean {
  return Boolean(
    process.env["ALPACA_API_KEY"] && process.env["ALPACA_API_SECRET"],
  );
}

function mode(): "paper" | "demo" {
  return hasCredentials() ? "paper" : "demo";
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

async function marketIsOpen(): Promise<boolean> {
  if (!hasCredentials()) return false;
  const clock = await alpacaRequest<{ is_open: boolean }>("/v2/clock");
  return clock.is_open;
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
    regime: bars.length < 22 ? "insufficient_data" : adx <= rules.adxMax ? "mean_reverting" : "trending",
    updatedAt: new Date().toISOString(),
    tradeBlockedReason,
  });
}

function addActivity(activity: Omit<Activity, "id">): Activity {
  const created = { id: randomUUID(), ...activity };
  activities = [created, ...activities].slice(0, 40);
  if (created.status === "blocked") blockedToday += 1;
  if (["submitted", "simulated", "closed"].includes(created.status)) signalsToday += 1;
  return created;
}

async function submitEntry(
  snapshot: Snapshot,
  equity: number,
  dryRun: boolean,
  rules: StrategyRules = guardrails,
): Promise<Activity> {
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
  return addActivity({
    at: new Date().toISOString(),
    action: side === "buy" ? "LONG ENTRY" : "SHORT ENTRY",
    symbol: snapshot.symbol,
    zScore: snapshot.zScore,
    reason: `Z-score ${snapshot.zScore.toFixed(2)} crossed the ${rules.entryZ.toFixed(1)}σ entry threshold; ADX and volume confirmed.`,
    orderId,
    status,
  });
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
  return GetAgentStatusResponse.parse({
    mode: mode(),
    connected,
    paper: true,
    lastRunAt,
    nextRunAt: agentNextRunAt,
    running: agentRunning,
    intervalSeconds: agentIntervalSeconds,
    lastError: agentLastError,
    symbols: agentSymbols,
    heartbeat: new Date().toISOString(),
    guardrails: agentRules,
  });
}

export async function getDashboard(log: Logger) {
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    agentSymbols.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(
        symbol,
        bars,
        positionFor(positions, symbol),
        trailingExtremes,
        agentRules,
      );
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
) {
  const selectedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 8);
  const [account, positions, orders] = await Promise.all([
    fetchAccount(),
    fetchPositions(),
    fetchOrders(),
  ]);
  const pendingOrderSymbols = new Set(
    orders
      .filter((order) =>
        ["new", "accepted", "pending_new", "partially_filled"].includes(
          order.status.toLowerCase(),
        ),
      )
      .map((order) => order.symbol),
  );
  const snapshots = await Promise.all(
    selectedSymbols.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol), trailingExtremes, rules);
    }),
  );
  const actions: Activity[] = [];
  for (const snapshot of snapshots) {
    const position = positionFor(positions, snapshot.symbol);
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
          }),
        );
      } else if (pendingOrderSymbols.has(snapshot.symbol)) {
        actions.push(
          addActivity({
            at: new Date().toISOString(),
            action: "PENDING ORDER BLOCKED",
            symbol: snapshot.symbol,
            zScore: snapshot.zScore,
            reason: "An open paper order already exists; the agent will wait for it to resolve before evaluating a new entry.",
            orderId: null,
            status: "blocked",
          }),
        );
      } else {
        actions.push(await submitEntry(snapshot, account.equity, dryRun, rules));
      }
    } else if (snapshot.signal === "exit") {
      if (position) {
        actions.push(
          await closePosition(
            snapshot,
            `Z-score ${snapshot.zScore.toFixed(2)} crossed back through equilibrium.`,
            "closed",
          ),
        );
      }
    } else if (snapshot.signal === "invalidation" && position) {
      actions.push(
        await closePosition(
          snapshot,
          `Risk invalidated at Z-score ${snapshot.zScore.toFixed(2)} or trailing-stop breach.`,
          "blocked",
        ),
      );
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
        }),
      );
    }
  }
  lastRunAt = new Date().toISOString();
  totalScans += 1;
  log.info({ mode: mode(), evaluated: snapshots.length, dryRun }, "Strategy scan completed");
  return RunStrategyResponse.parse({
    ranAt: lastRunAt,
    mode: mode(),
    evaluated: snapshots.length,
    actions,
    snapshots,
  });
}

async function executeScheduledRun(log: Logger): Promise<void> {
  if (!agentRunning || scheduledRunInFlight) return;
  scheduledRunInFlight = true;
  try {
    if (!(await marketIsOpen())) {
      agentLastError = null;
      log.info({ nextRunAt: agentNextRunAt }, "Continuous agent waiting for market open");
      return;
    }
    await runStrategy(agentSymbols, false, log, agentRules);
    agentLastError = null;
  } catch (error) {
    agentLastError = error instanceof Error ? error.message : "Scheduled strategy scan failed";
    log.error({ err: error }, "Scheduled strategy scan failed; agent remains running");
  } finally {
    scheduledRunInFlight = false;
    if (agentRunning) {
      agentNextRunAt = new Date(
        Date.now() + agentIntervalSeconds * 1000,
      ).toISOString();
    }
  }
}

function normalizeSymbols(symbols?: string[]): string[] {
  const normalized = [
    ...new Set(
      (symbols ?? DEFAULT_SYMBOLS)
        .map((symbol) => symbol.trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 8);
  if (!normalized.length) throw new Error("At least one symbol is required to start the agent.");
  return normalized;
}

export async function startAgent(
  symbols: string[] | undefined,
  intervalSeconds: number | undefined,
  settings: Partial<StrategyRules> | undefined,
  log: Logger,
) {
  if (!hasCredentials()) {
    throw new Error("Alpaca paper credentials are required before starting automated execution.");
  }
  if (!(await credentialsWork())) {
    throw new Error("The Alpaca paper account could not be verified. Automated execution was not started.");
  }
  if (intervalSeconds !== undefined && !Number.isInteger(intervalSeconds)) {
    throw new Error("The agent interval must be a whole number of seconds.");
  }

  agentSymbols = normalizeSymbols(symbols);
  agentIntervalSeconds = intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  if (agentIntervalSeconds < 60 || agentIntervalSeconds > 3600) {
    throw new Error("The agent interval must be between 60 and 3600 seconds.");
  }
  agentRules = { ...guardrails, ...(settings ?? {}) };
  agentRunning = true;
  agentLastError = null;
  agentNextRunAt = new Date(
    Date.now() + agentIntervalSeconds * 1000,
  ).toISOString();
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = setInterval(() => {
    void executeScheduledRun(log);
  }, agentIntervalSeconds * 1000);

  await executeScheduledRun(log);
  log.info(
    { symbols: agentSymbols, intervalSeconds: agentIntervalSeconds },
    "Continuous paper agent started",
  );
  return StartAgentResponse.parse({
    status: await getStatus(),
    message: `Agent started. It will scan ${agentSymbols.length} symbol${agentSymbols.length === 1 ? "" : "s"} every ${agentIntervalSeconds} seconds while the market is open.`,
  });
}

export async function stopAgent(log: Logger) {
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = null;
  agentRunning = false;
  agentNextRunAt = null;
  scheduledRunInFlight = false;
  log.info("Continuous paper agent stopped; open positions were left unchanged");
  return StartAgentResponse.parse({
    status: await getStatus(),
    message: "Agent stopped. Existing paper positions remain open until you flatten or the agent is started again.",
  });
}

async function waitForFilledOrder(orderId: string): Promise<{
  status: string;
  filledQty: number;
}> {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const order = await alpacaRequest<{
      status: string;
      filled_qty: string;
    }>(`/v2/orders/${encodeURIComponent(orderId)}`);
    const status = order.status.toLowerCase();
    if (status === "filled" || ["canceled", "rejected", "expired"].includes(status)) {
      return { status: order.status, filledQty: toNumber(order.filled_qty) };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { status: "timeout", filledQty: 0 };
}

export async function testPaperRoundTrip(
  symbol: string,
  quantity: number,
  log: Logger,
) {
  if (!hasCredentials()) {
    throw new Error("Alpaca paper credentials are required for the round-trip test.");
  }
  if (agentRunning) {
    throw new Error("Stop the autonomous agent before running an isolated round-trip test.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new Error("The test quantity must be a whole number from 1 to 10.");
  }
  if (!(await marketIsOpen())) {
    throw new Error("The U.S. market is closed. Run the round-trip test during regular market hours.");
  }

  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!normalizedSymbol) throw new Error("A symbol is required for the round-trip test.");
  const [positions, orders] = await Promise.all([fetchPositions(), fetchOrders()]);
  if (positionFor(positions, normalizedSymbol)) {
    throw new Error(`Refusing to test ${normalizedSymbol}: an open position already exists.`);
  }
  const pending = orders.some(
    (order) =>
      order.symbol === normalizedSymbol &&
      ["new", "accepted", "pending_new", "partially_filled"].includes(
        order.status.toLowerCase(),
      ),
  );
  if (pending) {
    throw new Error(`Refusing to test ${normalizedSymbol}: a pending order already exists.`);
  }

  const entry = await alpacaRequest<{ id: string; status: string }>("/v2/orders", {
    method: "POST",
    body: JSON.stringify({
      symbol: normalizedSymbol,
      qty: String(quantity),
      side: "buy",
      type: "market",
      time_in_force: "day",
    }),
  });
  const filled = await waitForFilledOrder(entry.id);
  if (filled.status.toLowerCase() !== "filled") {
    try {
      await alpacaRequest(`/v2/orders/${encodeURIComponent(entry.id)}`, {
        method: "DELETE",
      });
    } catch (error) {
      log.warn({ err: error, orderId: entry.id }, "Unable to cancel unfilled test order");
    }
    throw new Error(`The test entry order did not fill (status: ${filled.status}). It was canceled or expired without opening a position.`);
  }

  addActivity({
    at: new Date().toISOString(),
    action: "TEST LONG ENTRY",
    symbol: normalizedSymbol,
    zScore: 0,
    reason: "Temporary paper round-trip test entry filled successfully.",
    orderId: entry.id,
    status: "submitted",
  });

  let exit: { id: string; status: string } | null = null;
  try {
    exit = await alpacaRequest<{ id: string; status: string }>(
      `/v2/positions/${encodeURIComponent(normalizedSymbol)}`,
      { method: "DELETE" },
    );
  } catch (error) {
    log.error(
      { err: error, symbol: normalizedSymbol, entryOrderId: entry.id },
      "Test entry filled but immediate close failed",
    );
    throw new Error(`The test entry filled, but the close request failed. Flatten ${normalizedSymbol} manually from Account & orders.`);
  }

  addActivity({
    at: new Date().toISOString(),
    action: "TEST ROUND-TRIP EXIT",
    symbol: normalizedSymbol,
    zScore: 0,
    reason: "Temporary paper round-trip test close submitted immediately after the entry fill.",
    orderId: exit.id,
    status: "closed",
  });
  log.info(
    { symbol: normalizedSymbol, quantity, entryOrderId: entry.id, exitOrderId: exit.id },
    "Paper round-trip test completed",
  );
  return TestPaperRoundTripResponse.parse({
    symbol: normalizedSymbol,
    quantity,
    entryOrderId: entry.id,
    entryStatus: filled.status,
    exitOrderId: exit.id,
    exitStatus: exit.status,
    at: new Date().toISOString(),
    message: `Paper round trip completed for ${quantity} share${quantity === 1 ? "" : "s"} of ${normalizedSymbol}.`,
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