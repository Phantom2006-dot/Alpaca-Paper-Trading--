import { useState } from 'react';
import { useAuth } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Info, RefreshCw, ShoppingCart, TrendingDown, TrendingUp, X } from 'lucide-react';
import {
  getGetAgentAccountQueryKey,
  getGetAgentDashboardQueryKey,
  useGetAgentAccount,
  useGetAgentStatus,
  getGetAgentStatusQueryKey,
} from '@workspace/api-client-react';

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function money(value = 0) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value);
}

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

type OrderResult = {
  orderId: string | null;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: string;
  status: 'submitted' | 'simulated';
  mode: 'paper' | 'demo';
  submittedAt: string;
  message: string;
};

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export function TradesPage() {
  const { getToken } = useAuth();
  const queryClient = useQueryClient();
  const accountQuery = useGetAgentAccount({ query: { queryKey: getGetAgentAccountQueryKey(), refetchInterval: 15000 } });
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 } });

  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState('1');
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [recentOrders, setRecentOrders] = useState<OrderResult[]>([]);

  const isDemo = statusQuery.data?.mode === 'demo';

  async function submit() {
    const sym = symbol.trim().toUpperCase();
    const qtyNum = Number(qty);
    if (!sym) { setNotice({ type: 'error', text: 'Enter a symbol.' }); return; }
    if (!Number.isFinite(qtyNum) || qtyNum <= 0) { setNotice({ type: 'error', text: 'Quantity must be a positive number.' }); return; }
    if (orderType === 'limit' && (!limitPrice || !Number.isFinite(Number(limitPrice)) || Number(limitPrice) <= 0)) {
      setNotice({ type: 'error', text: 'Enter a valid limit price.' });
      return;
    }
    setPending(true);
    setNotice(null);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/agent/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          symbol: sym,
          side,
          qty: qtyNum,
          orderType,
          limitPrice: orderType === 'limit' ? Number(limitPrice) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Order failed');
      setRecentOrders((prev) => [data as OrderResult, ...prev].slice(0, 20));
      setNotice({ type: 'success', text: data.message });
      setSymbol('');
      setQty('1');
      setLimitPrice('');
      queryClient.invalidateQueries({ queryKey: getGetAgentAccountQueryKey() });
      queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
    } catch (err) {
      setNotice({ type: 'error', text: err instanceof Error ? err.message : 'Order failed.' });
    } finally {
      setPending(false);
    }
  }

  const overview = accountQuery.data;

  return (
    <>
      <div className="page-intro">
        <div>
          <div className="eyebrow">Manual trades / order ticket</div>
          <h1 className="page-title">Place a paper order.</h1>
          <p className="page-description">Submit market or limit orders directly to your Alpaca paper account. All orders are paper-only — no live execution.</p>
        </div>
        <div className="mode-pill is-paper"><span className="mode-pill-dot" /> Paper only</div>
      </div>

      <div className="trades-layout">
        {/* ── ORDER TICKET ── */}
        <div className="panel trade-ticket">
          <div className="card-header">
            <div>
              <div className="eyebrow">01 / order ticket</div>
              <h2 className="card-title">New paper order</h2>
            </div>
            <div className={cx('status-chip', isDemo ? 'is-warn' : 'is-good')}>
              <span />{isDemo ? 'Demo mode' : 'Paper account'}
            </div>
          </div>

          {/* Side toggle */}
          <div className="trade-side-toggle">
            <button
              className={cx('trade-side-btn', side === 'buy' && 'is-buy')}
              onClick={() => setSide('buy')}
              type="button"
            >
              <TrendingUp size={14} /> Buy
            </button>
            <button
              className={cx('trade-side-btn', side === 'sell' && 'is-sell')}
              onClick={() => setSide('sell')}
              type="button"
            >
              <TrendingDown size={14} /> Sell
            </button>
          </div>

          <div className="trade-fields">
            <label>
              <span className="field-label">Symbol</span>
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="e.g. SPY"
                maxLength={10}
                data-testid="input-trade-symbol"
              />
            </label>
            <label>
              <span className="field-label">Quantity (shares)</span>
              <input
                type="number"
                min="1"
                step="1"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                data-testid="input-trade-qty"
              />
            </label>
            <label>
              <span className="field-label">Order type</span>
              <select value={orderType} onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')} data-testid="select-trade-order-type">
                <option value="market">Market</option>
                <option value="limit">Limit</option>
              </select>
            </label>
            {orderType === 'limit' && (
              <label>
                <span className="field-label">Limit price (USD)</span>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={limitPrice}
                  onChange={(e) => setLimitPrice(e.target.value)}
                  placeholder="0.00"
                  data-testid="input-trade-limit-price"
                />
              </label>
            )}
          </div>

          {notice && (
            <div className={cx('notice-banner', notice.type === 'error' && 'is-error')} data-testid="status-trade-notice">
              {notice.type === 'success' ? <Check size={14} /> : <AlertTriangle size={14} />}
              <span>{notice.text}</span>
              <button onClick={() => setNotice(null)} aria-label="Dismiss"><X size={13} /></button>
            </div>
          )}

          <div className="trade-ticket-footer">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Info size={13} /> Orders route to paper-api.alpaca.markets only
            </div>
            <button
              className={cx('button', side === 'buy' ? 'button-primary' : 'button-danger')}
              onClick={submit}
              disabled={pending}
              data-testid="button-submit-trade"
            >
              {pending ? <RefreshCw size={13} className="animate-spin" /> : <ShoppingCart size={13} />}
              {pending ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'} ${symbol || '—'}`}
            </button>
          </div>
        </div>

        {/* ── POSITIONS ── */}
        <div className="panel overflow-hidden">
          <div className="card-header">
            <div>
              <div className="eyebrow">02 / open exposure</div>
              <h2 className="card-title">Positions</h2>
            </div>
            <button className="icon-button" onClick={() => accountQuery.refetch()} disabled={accountQuery.isFetching} aria-label="Refresh positions">
              <RefreshCw size={13} className={accountQuery.isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
          {accountQuery.isLoading ? (
            <div className="p-5 text-xs text-muted-foreground">Loading…</div>
          ) : !overview?.positions.length ? (
            <div className="empty-state"><div className="empty-state-mark" /><div className="font-display text-sm font-bold">No open positions</div></div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Unrealized</th></tr></thead>
                <tbody>
                  {overview.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td><strong>{p.symbol}</strong></td>
                      <td className="text-xs uppercase">{p.side}</td>
                      <td className="font-mono text-xs">{p.qty}</td>
                      <td className="font-mono text-xs">{money(p.avgEntryPrice)}</td>
                      <td className="font-mono text-xs">{money(p.currentPrice)}</td>
                      <td className={cx('font-mono text-xs', p.unrealizedPnl >= 0 ? 'text-primary' : 'text-destructive')}>{money(p.unrealizedPnl)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* ── THIS SESSION'S ORDERS ── */}
      {recentOrders.length > 0 && (
        <div className="panel overflow-hidden mt-5">
          <div className="card-header">
            <div>
              <div className="eyebrow">03 / this session</div>
              <h2 className="card-title">Orders placed</h2>
            </div>
            <span className="font-mono text-[10px] text-muted-foreground">{recentOrders.length} order{recentOrders.length !== 1 ? 's' : ''}</span>
          </div>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Type</th><th>Status</th><th>Order ID</th><th>Submitted</th></tr></thead>
              <tbody>
                {recentOrders.map((o, i) => (
                  <tr key={`${o.orderId ?? i}-${o.submittedAt}`}>
                    <td><strong>{o.symbol}</strong></td>
                    <td className={cx('text-xs font-bold uppercase', o.side === 'buy' ? 'text-primary' : 'text-destructive')}>{o.side}</td>
                    <td className="font-mono text-xs">{o.qty}</td>
                    <td className="text-xs uppercase">{o.orderType}</td>
                    <td><span className={cx('trade-state', o.status === 'submitted' ? 'is-clear' : 'is-blocked')}>{o.status}</span></td>
                    <td className="font-mono text-[10px] text-muted-foreground">{o.orderId ? o.orderId.slice(0, 8) + '…' : 'demo'}</td>
                    <td className="font-mono text-xs">{formatDateTime(o.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── FULL ORDER HISTORY ── */}
      <div className="panel overflow-hidden mt-5">
        <div className="card-header">
          <div>
            <div className="eyebrow">04 / order history</div>
            <h2 className="card-title">Recent Alpaca orders</h2>
          </div>
          <span className="font-mono text-[10px] text-muted-foreground">{overview?.orders.length ?? 0} returned</span>
        </div>
        {accountQuery.isLoading ? (
          <div className="p-5 text-xs text-muted-foreground">Loading…</div>
        ) : !overview?.orders.length ? (
          <div className="empty-state"><div className="empty-state-mark" /><div className="font-display text-sm font-bold">No orders returned</div><p className="mt-1 text-xs text-muted-foreground">Paper orders submitted through the agent or manually will appear here.</p></div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Status</th><th>Qty</th><th>Submitted</th></tr></thead>
              <tbody>
                {overview.orders.map((o) => (
                  <tr key={o.id}>
                    <td><strong>{o.symbol}</strong></td>
                    <td className="text-xs uppercase">{o.side}</td>
                    <td className="text-xs uppercase">{o.type}</td>
                    <td><span className="trade-state is-clear">{o.status}</span></td>
                    <td className="font-mono text-xs">{o.filledQty} / {o.qty}</td>
                    <td className="font-mono text-xs">{formatDateTime(o.submittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
