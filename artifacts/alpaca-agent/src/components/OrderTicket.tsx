import { useMemo, useState } from 'react';
import { useGetAgentAssets } from '@workspace/api-client-react';
import type { TradableAsset } from '@workspace/api-client-react';

/**
 * Order ticket with a searchable symbol picker backed by the real Alpaca
 * /v2/assets universe (all tradable US stocks & ETFs). Used wherever an
 * order can be placed from the UI.
 */

export type OrderDraft = {
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  orderType: 'market' | 'limit';
  limitPrice?: number;
};

export function OrderTicket({
  onSubmit,
  pending,
  compact,
}: {
  onSubmit: (draft: OrderDraft) => void;
  pending?: boolean;
  compact?: boolean;
}) {
  const [search, setSearch] = useState('');
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [qty, setQty] = useState(1);
  const [orderType, setOrderType] = useState<'market' | 'limit'>('market');
  const [limitPrice, setLimitPrice] = useState('');

  const assetsQuery = useGetAgentAssets(
    { search },
    {
      query: {
        queryKey: ['agent-assets', search],
        staleTime: 300_000,
        enabled: search.trim().length > 0,
      },
    },
  );

  const results: TradableAsset[] = useMemo(
    () => (search.trim() ? (assetsQuery.data ?? []).slice(0, 6) : []),
    [assetsQuery.data, search],
  );

  const valid = symbol.trim().length > 0 && qty > 0 && (orderType === 'market' || Number(limitPrice) > 0);

  return (
    <div className="order-ticket" style={{ display: 'grid', gap: 8 }}>
      <div style={{ position: 'relative' }}>
        <input
          className="chat-input"
          style={{ width: '100%' }}
          placeholder="Search symbol (e.g. AAPL, SPY, VOO)…"
          value={symbol || search}
          onChange={(e) => {
            setSearch(e.target.value.toUpperCase());
            setSymbol('');
          }}
          aria-label="Symbol search"
        />
        {results.length > 0 && (
          <div
            style={{
              position: 'absolute',
              zIndex: 30,
              top: '100%',
              left: 0,
              right: 0,
              background: 'var(--card, #161b26)',
              border: '1px solid rgba(148,163,184,0.2)',
              borderRadius: 8,
              marginTop: 4,
              overflow: 'hidden',
            }}
          >
            {results.map((asset) => (
              <button
                key={asset.symbol}
                style={{
                  display: 'flex',
                  width: '100%',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px',
                  fontSize: 12,
                  textAlign: 'left',
                  borderBottom: '1px solid rgba(148,163,184,0.08)',
                }}
                onClick={() => {
                  setSymbol(asset.symbol);
                  setSearch('');
                }}
              >
                <strong style={{ fontFamily: 'monospace' }}>{asset.symbol}</strong>
                <span style={{ color: '#8b93a7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {asset.name} · {asset.exchange}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!compact && symbol && (
        <div style={{ fontSize: 11, color: '#8b93a7' }}>
          Selected: <strong style={{ fontFamily: 'monospace' }}>{symbol}</strong>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ display: 'flex', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(148,163,184,0.2)' }}>
          <button
            type="button"
            onClick={() => setSide('buy')}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              background: side === 'buy' ? '#22c55e' : 'transparent',
              color: side === 'buy' ? '#052e16' : '#8b93a7',
            }}
          >
            BUY
          </button>
          <button
            type="button"
            onClick={() => setSide('sell')}
            style={{
              padding: '6px 14px',
              fontSize: 12,
              fontWeight: 700,
              background: side === 'sell' ? '#ef4444' : 'transparent',
              color: side === 'sell' ? '#450a0a' : '#8b93a7',
            }}
          >
            SELL
          </button>
        </div>
        <input
          className="chat-input"
          style={{ width: 90 }}
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
          aria-label="Quantity"
        />
        <select
          className="chat-input"
          style={{ width: 100 }}
          value={orderType}
          onChange={(e) => setOrderType(e.target.value as 'market' | 'limit')}
          aria-label="Order type"
        >
          <option value="market">Market</option>
          <option value="limit">Limit</option>
        </select>
        {orderType === 'limit' && (
          <input
            className="chat-input"
            style={{ width: 110 }}
            type="number"
            step="0.01"
            min={0.01}
            placeholder="Limit $"
            value={limitPrice}
            onChange={(e) => setLimitPrice(e.target.value)}
            aria-label="Limit price"
          />
        )}
        <button
          className="button button-primary"
          disabled={!valid || pending}
          onClick={() =>
            onSubmit({
              symbol: symbol.trim().toUpperCase(),
              side,
              qty,
              orderType,
              limitPrice: orderType === 'limit' ? Number(limitPrice) : undefined,
            })
          }
        >
          {pending ? '…' : 'Place paper order'}
        </button>
      </div>
    </div>
  );
}
