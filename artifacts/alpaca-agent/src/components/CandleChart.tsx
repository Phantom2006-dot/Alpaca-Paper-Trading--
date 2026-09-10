import { useState } from 'react';
import { useGetAgentAssets, useGetMarketBars } from '@workspace/api-client-react';
import type { MarketBars, GetMarketBarsTimeframe, TradableAsset } from '@workspace/api-client-react';

/**
 * TradingView-style candlestick chart, self-contained:
 *  - symbol quick-picker: search across the REAL Alpaca /v2/assets universe
 *  - timeframe tabs: 1m / 5m / 15m / 1h / 1D
 *  - candles + volume from GET /api/agent/bars (feed fallback handled server-side)
 * The parent can drive the symbol (e.g. clicking a scanner row) via
 * `symbol` + `onSymbolChange`; without them the chart manages its own state.
 */

const CHART_W = 720;
const CHART_H = 260;
const PAD = { top: 12, right: 52, bottom: 22, left: 8 };
const VOL_H = 52;

const TIMEFRAMES: Array<{ value: GetMarketBarsTimeframe; label: string }> = [
  { value: '1Min', label: '1m' },
  { value: '5Min', label: '5m' },
  { value: '15Min', label: '15m' },
  { value: '1Hour', label: '1h' },
  { value: '1Day', label: '1D' },
];

function fmtPrice(v: number): string {
  return v >= 1000 ? v.toFixed(0) : v.toFixed(2);
}

function fmtTime(t: string | null | undefined, timeframe: string): string {
  if (!t) return '';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return timeframe === '1Day'
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function CandleChart({
  symbol: controlledSymbol,
  onSymbolChange,
  timeframe: controlledTimeframe,
}: {
  symbol?: string;
  onSymbolChange?: (symbol: string) => void;
  timeframe?: GetMarketBarsTimeframe;
}) {
  const [internalSymbol, setInternalSymbol] = useState('SPY');
  const [internalTimeframe, setInternalTimeframe] = useState<GetMarketBarsTimeframe>('1Day');
  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const symbol = (controlledSymbol ?? internalSymbol).toUpperCase();
  const timeframe = controlledTimeframe ?? internalTimeframe;

  const barsQuery = useGetMarketBars(
    { symbol, timeframe, feed: 'auto', limit: 120 },
    { query: { queryKey: ['agent-bars', symbol, timeframe], staleTime: 60_000, refetchInterval: 60_000 } },
  );

  // Search across the real Alpaca asset universe (stocks & ETFs).
  const assetsQuery = useGetAgentAssets(
    { search },
    { query: { queryKey: ['agent-assets-chart', search], staleTime: 300_000, enabled: pickerOpen && search.trim().length > 0 } },
  );

  const data: MarketBars | undefined = barsQuery.data;
  const bars = data?.bars ?? [];
  const feed = data?.feed ?? (barsQuery.isError ? 'error' : '—');
  const showEmpty = !barsQuery.isLoading && bars.length === 0;

  const last = bars.at(-1);
  const prev = bars.at(-2);
  const changeAbs = last && prev ? last.c - prev.c : 0;
  const changePct = last && prev && prev.c ? (changeAbs / prev.c) * 100 : 0;
  const upDay = changeAbs >= 0;

  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom - VOL_H;
  const maxPrice = bars.length ? Math.max(...bars.map((b) => b.h)) : 1;
  const minPrice = bars.length ? Math.min(...bars.map((b) => b.l)) : 0;
  const range = maxPrice - minPrice || 1;
  const maxVol = bars.length ? Math.max(...bars.map((b) => b.v)) : 1;
  const xOf = (i: number) => PAD.left + ((i + 0.5) / Math.max(bars.length, 1)) * plotW;
  const yOf = (p: number) => PAD.top + (1 - (p - minPrice) / range) * plotH;
  const gridLines = 4;

  const pickSymbol = (s: string) => {
    setInternalSymbol(s);
    onSymbolChange?.(s);
    setSearch('');
    setPickerOpen(false);
  };

  const results: TradableAsset[] = search.trim() ? (assetsQuery.data ?? []).slice(0, 7) : [];

  return (
    <div className="panel" data-testid="panel-candle-chart">
      {/* Toolbar: symbol picker + change + timeframe tabs */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 10,
          padding: '12px 16px 0',
        }}
      >
        <div style={{ position: 'relative' }}>
          <button
            className="console-symbol-chip is-active"
            style={{ fontSize: 14, padding: '4px 12px' }}
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            data-testid="button-chart-symbol"
          >
            {symbol} ▾
          </button>
          {pickerOpen && (
            <div
              style={{
                position: 'absolute',
                zIndex: 40,
                top: '100%',
                left: 0,
                width: 320,
                background: 'var(--card, #161b26)',
                border: '1px solid rgba(148,163,184,0.2)',
                borderRadius: 8,
                marginTop: 6,
                padding: 8,
                boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
              }}
            >
              <input
                autoFocus
                className="chat-input"
                style={{ width: '100%', marginBottom: 6 }}
                placeholder="Search all Alpaca stocks & ETFs…"
                value={search}
                onChange={(e) => setSearch(e.target.value.toUpperCase())}
                aria-label="Chart symbol search"
              />
              {results.map((asset) => (
                <button
                  key={asset.symbol}
                  style={{
                    display: 'flex',
                    width: '100%',
                    justifyContent: 'space-between',
                    gap: 8,
                    padding: '7px 8px',
                    fontSize: 12,
                    textAlign: 'left',
                    borderRadius: 6,
                  }}
                  onClick={() => pickSymbol(asset.symbol)}
                >
                  <strong style={{ fontFamily: 'monospace' }}>{asset.symbol}</strong>
                  <span style={{ color: '#8b93a7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {asset.name} · {asset.exchange}
                  </span>
                </button>
              ))}
              {search.trim() && !assetsQuery.isLoading && results.length === 0 && (
                <p style={{ fontSize: 11, color: '#8b93a7', padding: '4px 8px' }}>No tradable assets match.</p>
              )}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                {['SPY', 'QQQ', 'IWM', 'AAPL', 'TSLA', 'NVDA'].map((s) => (
                  <button key={s} className="console-symbol-chip" style={{ fontSize: 10.5, padding: '3px 8px' }} onClick={() => pickSymbol(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {last && (
          <span style={{ fontSize: 16, fontWeight: 700, fontFamily: 'monospace' }}>
            ${last.c.toFixed(2)}
            <span style={{ fontSize: 12, marginLeft: 8, color: upDay ? '#22c55e' : '#ef4444' }}>
              {upDay ? '▲' : '▼'} {Math.abs(changeAbs).toFixed(2)} ({changePct >= 0 ? '+' : ''}
              {changePct.toFixed(2)}%)
            </span>
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {TIMEFRAMES.map((tf) => (
            <button
              key={tf.value}
              className="console-symbol-chip"
              style={{
                fontSize: 11,
                padding: '3px 9px',
                background: timeframe === tf.value ? 'rgba(99,102,241,0.25)' : 'transparent',
                borderColor: timeframe === tf.value ? 'rgba(99,102,241,0.6)' : undefined,
              }}
              onClick={() => setInternalTimeframe(tf.value)}
              data-testid={`button-tf-${tf.label}`}
            >
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      <div className="card-header" style={{ paddingTop: 8 }}>
        <div>
          <div className="eyebrow">price action · {timeframe}</div>
        </div>
        <div style={{ fontSize: 11, color: '#8b93a7' }}>
          feed: <strong>{feed}</strong>
          {bars.length > 0 && ` · ${bars.length} bars`}
        </div>
      </div>

      {showEmpty ? (
        <p style={{ padding: 16, fontSize: 13, color: '#8b93a7' }}>
          No bars returned by any feed (iex → sip → delayed_sip) for <strong>{symbol}</strong> on the{' '}
          {timeframe} timeframe. Market may be closed, the symbol may not be covered by the free IEX
          feed, or the data subscription lacks it. See Market Data Diagnostics below for exact
          upstream responses.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: '100%', height: 'auto', display: 'block', paddingBottom: 10 }}
          role="img"
          aria-label={`${symbol} candlestick chart`}
        >
          {Array.from({ length: gridLines + 1 }, (_, i) => {
            const p = minPrice + (range * i) / gridLines;
            const y = yOf(p);
            return (
              <g key={i}>
                <line x1={PAD.left} x2={CHART_W - PAD.right} y1={y} y2={y} stroke="rgba(148,163,184,0.12)" strokeWidth={1} />
                <text x={CHART_W - PAD.right + 6} y={y + 3.5} fontSize={10} fill="#8b93a7">
                  {fmtPrice(p)}
                </text>
              </g>
            );
          })}

          {bars.map((b, i) => {
            const up = b.c >= b.o;
            const color = up ? '#22c55e' : '#ef4444';
            const x = xOf(i);
            const width = Math.max((plotW / Math.max(bars.length, 1)) * 0.6, 1);
            const bodyTop = yOf(Math.max(b.o, b.c));
            const bodyBottom = yOf(Math.min(b.o, b.c));
            const volH = (b.v / maxVol) * (VOL_H - 6);
            return (
              <g key={i}>
                <line x1={x} x2={x} y1={yOf(b.h)} y2={yOf(b.l)} stroke={color} strokeWidth={1} />
                <rect
                  x={x - width / 2}
                  y={bodyTop}
                  width={width}
                  height={Math.max(bodyBottom - bodyTop, 1)}
                  fill={color}
                  opacity={up ? 0.95 : 0.9}
                />
                <rect
                  x={x - width / 2}
                  y={CHART_H - PAD.bottom - volH}
                  width={width}
                  height={volH}
                  fill={color}
                  opacity={0.25}
                />
              </g>
            );
          })}

          {bars
            .filter((_, i) => i % Math.ceil(bars.length / 8) === 0)
            .map((b, idx) => (
              <text
                key={`t-${b.t ?? idx}`}
                x={xOf(bars.indexOf(b))}
                y={CHART_H - 6}
                fontSize={9.5}
                fill="#8b93a7"
                textAnchor="middle"
              >
                {fmtTime(b.t, timeframe)}
              </text>
            ))}
        </svg>
      )}
    </div>
  );
}
