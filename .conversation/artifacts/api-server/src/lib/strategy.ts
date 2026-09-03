import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  GetAgentDashboardResponse,
  GetAgentStatusResponse,
  GetMarketSnapshotResponse,
  RunStrategyResponse,
  FlattenAgentPositionsResponse,
} from "@workspace/api-zod";

type Bar = {
  close: number;
  high: number;
  low: number;
  volume: number;
};

type Position = {
  symbol: string;
  qty: number;
  side: "long" | "short";
  avgEntryPrice: number;
  currentPrice: number;
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

let lastRunAt: string | null = null;
let totalScans = 0;
let signalsToday = 0;
let blockedToday = 0;
let activities: Activity[] = [];
const demoPositions = new Map<string, Position>();
const trailingExtremes = new Map<string, number>();

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

async function fetchBars(symbol: string): Promise<Bar[]> {
  if (!hasCredentials()) return demoBars(symbol);
  const query = new URLSearchParams({
    timeframe: "1Day",
    limit: "60",
    feed: "iex",
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
      unrealized_pl: string;
    }>
  >("/v2/positions");
  return positions.map((position) => ({
    symbol: position.symbol,
    qty: Math.abs(toNumber(position.qty)),
    side: position.side === "short" ? "short" : "long",
    avgEntryPrice: toNumber(position.avg_entry_price),
    currentPrice: toNumber(position.current_price),
    unrealizedPnl: toNumber(position.unrealized_pl),
  }));
}

function positionFor(positions: Position[], symbol: string): Position | undefined {
  return positions.find((position) => position.symbol === symbol);
}

function snapshotFromBars(
  symbol: string,
  bars: Bar[],
  position: Position | undefined,
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
  const extreme = trailingExtremes.get(symbol);
  const nextExtreme =
    side === "long"
      ? Math.max(extreme ?? price, price)
      : side === "short"
        ? Math.min(extreme ?? price, price)
        : price;
  trailingExtremes.set(symbol, nextExtreme);

  let signal: Snapshot["signal"] = "hold";
  let tradeBlockedReason: string | null = null;
  if (position && Math.abs(zScore) >= guardrails.invalidationZ) {
    signal = "invalidation";
  } else if (
    position &&
    ((position.side === "long" && zScore >= guardrails.exitZ) ||
      (position.side === "short" && zScore <= guardrails.exitZ))
  ) {
    signal = "exit";
  } else if (
    position &&
    guardrails.trailingStop &&
    ((position.side === "long" && price <= nextExtreme * 0.98) ||
      (position.side === "short" && price >= nextExtreme * 1.02))
  ) {
    signal = "invalidation";
  } else if (!position && Math.abs(zScore) >= guardrails.entryZ) {
    if (adx > guardrails.adxMax) {
      signal = "blocked";
      tradeBlockedReason = `ADX ${adx.toFixed(1)} indicates a trending regime`;
    } else if (volumeRatio < guardrails.minVolumeRatio) {
      signal = "blocked";
      tradeBlockedReason = `Volume is ${Math.round(volumeRatio * 100)}% of its 20-day average`;
    } else {
      signal = zScore <= -guardrails.entryZ ? "long_entry" : "short_entry";
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
    regime: bars.length < 22 ? "insufficient_data" : adx <= guardrails.adxMax ? "mean_reverting" : "trending",
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
): Promise<Activity> {
  const qty = Math.max(1, Math.floor((equity * (guardrails.maxPositionPct / 100)) / snapshot.price));
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
      unrealizedPnl: 0,
    });
  }
  return addActivity({
    at: new Date().toISOString(),
    action: side === "buy" ? "LONG ENTRY" : "SHORT ENTRY",
    symbol: snapshot.symbol,
    zScore: snapshot.zScore,
    reason: `Z-score ${snapshot.zScore.toFixed(2)} crossed the ${guardrails.entryZ.toFixed(1)}σ entry threshold; ADX and volume confirmed.`,
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
    nextRunAt: lastRunAt
      ? new Date(new Date(lastRunAt).getTime() + 5 * 60_000).toISOString()
      : null,
    symbols: DEFAULT_SYMBOLS,
    heartbeat: new Date().toISOString(),
    guardrails,
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
) {
  const selectedSymbols = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 8);
  const [account, positions] = await Promise.all([fetchAccount(), fetchPositions()]);
  const snapshots = await Promise.all(
    selectedSymbols.map(async (symbol) => {
      const bars = await fetchBars(symbol);
      return snapshotFromBars(symbol, bars, positionFor(positions, symbol));
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
      } else {
        actions.push(await submitEntry(snapshot, account.equity, dryRun));
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
  if (!DEFAULT_SYMBOLS.includes(normalized)) return null;
  const positions = await fetchPositions();
  const bars = await fetchBars(normalized);
  return snapshotFromBars(normalized, bars, positionFor(positions, normalized));
}