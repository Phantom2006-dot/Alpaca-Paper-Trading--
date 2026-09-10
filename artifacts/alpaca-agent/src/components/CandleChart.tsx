import { useGetMarketBars } from '@workspace/api-client-react';
import type { MarketBars, GetMarketBarsTimeframe } from '@workspace/api-client-react';

/**
 * Lightweight SVG candlestick chart (TradingView-style) rendered from real
 * Alpaca OHLCV bars served by GET /api/agent/bars. Pure SVG — no chart
 * library — keeps the bundle small and styling fully themeable.
 */

const CHART_W = 720;
const CHART_H = 260;
const PAD = { top: 12, right: 52, bottom: 22, left: 8 };
const VOL_H = 52; // reserved strip at the bottom for volume columns

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
  symbol,
  timeframe,
}: {
  symbol: string;
  timeframe: GetMarketBarsTimeframe;
}) {
  const barsQuery = useGetMarketBars(
    { symbol, timeframe, feed: 'auto', limit: 120 },
    { query: { queryKey: ['agent-bars', symbol, timeframe], staleTime: 60_000, refetchInterval: 60_000 } },
  );

  const data: MarketBars | undefined = barsQuery.data;
  const bars = data?.bars ?? [];
  const feed = data?.feed ?? (barsQuery.isError ? 'error' : '—');
  const dataNote = !barsQuery.isLoading && bars.length === 0;

  const plotW = CHART_W - PAD.left - PAD.right;
  const plotH = CHART_H - PAD.top - PAD.bottom - VOL_H;

  const maxPrice = bars.length ? Math.max(...bars.map((b) => b.h)) : 1;
  const minPrice = bars.length ? Math.min(...bars.map((b) => b.l)) : 0;
  const range = maxPrice - minPrice || 1;
  const maxVol = bars.length ? Math.max(...bars.map((b) => b.v)) : 1;

  const xOf = (i: number) => PAD.left + ((i + 0.5) / Math.max(bars.length, 1)) * plotW;
  const yOf = (p: number) => PAD.top + (1 - (p - minPrice) / range) * plotH;

  const gridLines = 4;

  return (
    <div className="panel" data-testid="panel-candle-chart">
      <div className="card-header">
        <div>
          <div className="eyebrow">price action</div>
          <h3>
            {symbol} · {timeframe} candles
          </h3>
        </div>
        <div style={{ fontSize: 11, color: '#8b93a7' }}>
          feed: <strong>{feed}</strong>
          {bars.length > 0 && ` · ${bars.length} bars`}
        </div>
      </div>

      {dataNote ? (
        <p style={{ padding: 16, fontSize: 13, color: '#8b93a7' }}>
          No bars returned by any feed (iex → sip → delayed_sip). This usually means the market is
          closed for this timeframe, the symbol is not covered by the free IEX feed, or the Alpaca
          data subscription lacks this asset. Open Market Data Diagnostics for the exact upstream
          responses.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`${symbol} candlestick chart`}
        >
          {/* grid + price axis */}
          {Array.from({ length: gridLines + 1 }, (_, i) => {
            const p = minPrice + (range * i) / gridLines;
            const y = yOf(p);
            return (
              <g key={i}>
                <line
                  x1={PAD.left}
                  x2={CHART_W - PAD.right}
                  y1={y}
                  y2={y}
                  stroke="rgba(148,163,184,0.12)"
                  strokeWidth={1}
                />
                <text x={CHART_W - PAD.right + 6} y={y + 3.5} fontSize={10} fill="#8b93a7">
                  {fmtPrice(p)}
                </text>
              </g>
            );
          })}

          {/* candles + volume */}
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

          {/* sparse time axis labels */}
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
