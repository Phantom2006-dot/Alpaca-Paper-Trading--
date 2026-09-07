import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '@clerk/react';
import { RefreshCw, ChevronRight, ChevronDown, AlertTriangle, Search, X } from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type AuditRun = {
  id: string;
  at: string;
  action: string;
  symbol: string;
  zScore: number;
  reason: string;
  orderId: string | null;
  status: 'simulated' | 'submitted' | 'blocked' | 'closed';
  runId: string;
  latencyMs: number;
  modelName: string;
  outcome: 'EXECUTED' | 'BLOCKED_BY_RISK' | 'NEUTRAL_SIGNAL';
  marketSnapshot: object;
  modelOutput: object;
  riskValidatorResult: object;
  alpacaResponse: object | null;
};

function formatDateTime(v?: string | null) {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return v;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

function JsonBlock({ label, data }: { label: string; data: object | null }) {
  const [open, setOpen] = useState(false);
  if (!data) return null;
  return (
    <div className="json-block">
      <button className="json-block-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <span>{label}</span>
      </button>
      {open && (
        <pre className="json-block-body">{JSON.stringify(data, null, 2)}</pre>
      )}
    </div>
  );
}

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

export function AuditPage() {
  const { getToken } = useAuth();
  const [runs, setRuns] = useState<AuditRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AuditRun | null>(null);
  const [filterSymbol, setFilterSymbol] = useState('');
  const [filterOutcome, setFilterOutcome] = useState('all');
  const [filterRunId, setFilterRunId] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/agent/audit`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRuns(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit runs');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    return runs.filter((r) => {
      if (filterSymbol && !r.symbol.includes(filterSymbol.toUpperCase())) return false;
      if (filterOutcome !== 'all' && r.outcome !== filterOutcome) return false;
      if (filterRunId && !r.runId.includes(filterRunId)) return false;
      return true;
    });
  }, [runs, filterSymbol, filterOutcome, filterRunId]);

  const outcomeClass = (o: string) =>
    o === 'EXECUTED' ? 'audit-outcome-exec' : o === 'BLOCKED_BY_RISK' ? 'audit-outcome-block' : 'audit-outcome-neutral';

  return (
    <div className="audit-layout">
      {/* Filter bar */}
      <div className="audit-filter-bar">
        <div className="audit-filter-field">
          <Search size={12} />
          <input placeholder="Symbol" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)} />
        </div>
        <div className="audit-filter-field">
          <Search size={12} />
          <input placeholder="Run ID" value={filterRunId} onChange={(e) => setFilterRunId(e.target.value)} />
        </div>
        <select value={filterOutcome} onChange={(e) => setFilterOutcome(e.target.value)} className="audit-filter-select">
          <option value="all">All outcomes</option>
          <option value="EXECUTED">EXECUTED</option>
          <option value="BLOCKED_BY_RISK">BLOCKED BY RISK</option>
          <option value="NEUTRAL_SIGNAL">NEUTRAL SIGNAL</option>
        </select>
        <button className="button button-secondary" onClick={load} disabled={loading}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <span className="audit-count">{filtered.length} runs</span>
      </div>

      {error && (
        <div className="notice-banner" style={{ borderColor: 'hsl(var(--destructive)/0.4)', background: 'hsl(var(--destructive)/0.07)', color: 'hsl(var(--destructive))' }}>
          <AlertTriangle size={14} /><span>{error}</span>
        </div>
      )}

      <div className="audit-split">
        {/* Left list */}
        <div className="audit-list">
          {loading && <div className="audit-list-empty">Loading…</div>}
          {!loading && filtered.length === 0 && (
            <div className="audit-list-empty">No audit runs match this filter. Run the agent to generate records.</div>
          )}
          {filtered.map((run) => (
            <button
              key={run.id}
              className={cx('audit-list-item', selected?.id === run.id && 'is-selected')}
              onClick={() => setSelected(run)}
            >
              <div className="audit-list-item-top">
                <span className="audit-list-symbol">{run.symbol}</span>
                <span className={cx('audit-outcome-tag', outcomeClass(run.outcome))}>{run.outcome.replace(/_/g, ' ')}</span>
              </div>
              <div className="audit-list-item-action">{run.action}</div>
              <div className="audit-list-item-meta">
                <span>{formatDateTime(run.at)}</span>
                <span className="font-mono text-[9px]">{run.latencyMs}ms</span>
              </div>
            </button>
          ))}
        </div>

        {/* Right detail */}
        <div className="audit-detail">
          {!selected ? (
            <div className="audit-detail-empty">
              <Search size={24} className="audit-detail-empty-icon" />
              <p>Select a run from the list to inspect its full decision trace.</p>
            </div>
          ) : (
            <div className="audit-detail-body">
              {/* Executive summary */}
              <div className="audit-summary">
                <div className="eyebrow">Decision summary</div>
                <h3 className="audit-summary-title">
                  {selected.outcome === 'EXECUTED'
                    ? `Why did the agent trade ${selected.symbol}?`
                    : selected.outcome === 'BLOCKED_BY_RISK'
                    ? `Why did the agent NOT trade ${selected.symbol}?`
                    : `Why did the agent hold on ${selected.symbol}?`}
                </h3>
                <p className="audit-summary-reason">{selected.reason}</p>
              </div>

              {/* Metadata */}
              <div className="audit-meta-grid">
                <div><span>Timestamp</span><strong>{formatDateTime(selected.at)}</strong></div>
                <div><span>Latency</span><strong className="font-mono">{selected.latencyMs}ms</strong></div>
                <div><span>Model</span><strong>{selected.modelName}</strong></div>
                <div><span>Run ID</span><strong className="font-mono text-[9px] break-all">{selected.runId}</strong></div>
                <div><span>Order ID</span><strong className="font-mono text-[9px]">{selected.orderId ?? '—'}</strong></div>
                <div><span>Status</span><strong>{selected.status}</strong></div>
              </div>

              {/* Raw JSON panels */}
              <div className="audit-json-panels">
                <JsonBlock label="Market Snapshot" data={selected.marketSnapshot} />
                <JsonBlock label="Model Output" data={selected.modelOutput} />
                <JsonBlock label="Risk Validator Result" data={selected.riskValidatorResult} />
                <JsonBlock label="Alpaca API Response" data={selected.alpacaResponse} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
