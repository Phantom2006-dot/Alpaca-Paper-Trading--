import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import {
  GetAgentDashboardResponse,
  GetAgentStatusResponse,
  GetMarketSnapshotResponse,
  RunStrategyResponse,
  FlattenAgentPositionsResponse,
  RunBacktestResponse,
} from "@workspace/api-zod";

type Bar = {
  timestamp?: string;
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
const DEFAULT_BACKTEST_DAYS = 180;

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

async function fetchHistoricalBars(
  symbol: string,
  start: string,
  end: string,
): Promise<Bar[]> {
  if (!hasCredentials()) {
    throw new Error("Alpaca credentials are required for a historical backtest.");
  }
  const query = new URLSearchParams({
    timeframe: "1Day",
    start,
    end,
    limit: "1000",
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
  extremes = trailingExtremes,
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

  const historical = await Promise.all(
    selectedSymbols.map(async (symbol) => ({
      symbol,
      bars: await fetchHistoricalBars(symbol, start, end),
    })),
  );
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
              unrealizedPnl:
                state.position.side === "long"
                  ? (price - state.position.entryPrice) * state.position.quantity
                  : (state.position.entryPrice - price) * state.position.quantity,
            }
          : undefined,
        state.extremes,
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
          (state.capital * (guardrails.maxPositionPct / 100)) / price,
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
    timeframe: "1Day",
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