import { useGetAgentStatus, getGetAgentStatusQueryKey } from '@workspace/api-client-react';
import { Check, X, AlertTriangle, ShieldCheck, LockKeyhole, Zap } from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

const KILL_SWITCH_STEPS = [
  { n: '01', label: 'Cancel pending orders', desc: 'All open paper orders are cancelled via DELETE /v2/orders.' },
  { n: '02', label: 'Market-sell open positions', desc: 'Every open paper position is closed at market via DELETE /v2/positions.' },
  { n: '03', label: 'Disarm automation loop', desc: 'The continuous agent timer is cleared. No further cycles will run.' },
  { n: '04', label: 'Lock the UI', desc: 'All Run and Start buttons are disabled until the agent is manually restarted.' },
];

export function RiskPage() {
  const statusQuery = useGetAgentStatus({
    query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 },
  });
  const g = statusQuery.data?.guardrails;

  const rules = g
    ? [
        { label: 'Volume confirmation', desc: 'Current volume must exceed the 20-bar average before a signal can advance.', enabled: g.volumeFilter, value: `${g.minVolumeRatio.toFixed(2)}x minimum` },
        { label: 'ADX trend gate', desc: 'Entries are blocked when ADX indicates a trending regime — mean reversion fights the tape.', enabled: g.adxFilter, value: `ADX < ${g.adxMax.toFixed(0)}` },
        { label: 'Hard invalidation', desc: 'A move beyond the invalidation band exits the thesis immediately, regardless of P&L.', enabled: g.hardInvalidation, value: `±${g.invalidationZ.toFixed(1)}σ` },
        { label: 'Trailing stop', desc: 'Profits are protected as a position moves back toward its mean. 2% trail from peak.', enabled: g.trailingStop, value: '2% trail' },
        { label: 'Duplicate position check', desc: 'One thesis, one position. Existing exposure blocks a duplicate entry on the same symbol.', enabled: g.duplicatePositionCheck, value: '1 position / symbol' },
        { label: 'Paper-only execution lock', desc: 'The execution adapter is hard-coded to paper-api.alpaca.markets. Live routing is impossible.', enabled: g.paperOnly, value: 'LOCKED' },
        { label: 'Max position size', desc: 'Each order is capped as a percentage of total equity to limit single-name concentration.', enabled: true, value: `${g.maxPositionPct}% of equity` },
        { label: 'Entry Z-score threshold', desc: 'Price must deviate sufficiently from its 20-bar mean before an entry is considered.', enabled: true, value: `±${g.entryZ.toFixed(1)}σ` },
        { label: 'Exit Z-score threshold', desc: 'Positions are closed when price returns to the mean.', enabled: true, value: `${g.exitZ.toFixed(1)}σ` },
      ]
    : [];

  return (
    <div className="risk-layout">
      {/* Rule matrix */}
      <div className="panel risk-matrix-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">01 / deterministic guardrails</div>
            <h2 className="card-title">Risk rule matrix</h2>
          </div>
          <div className="flex items-center gap-2">
            <LockKeyhole size={14} className="text-primary" />
            <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">Read-only</span>
          </div>
        </div>

        {statusQuery.isLoading && (
          <div className="p-6 text-sm text-muted-foreground">Loading guardrail state…</div>
        )}
        {statusQuery.isError && (
          <div className="p-6 flex items-center gap-2 text-destructive text-sm">
            <AlertTriangle size={14} /> Could not load guardrail state.
          </div>
        )}

        {rules.length > 0 && (
          <div className="risk-rule-list">
            {rules.map((rule) => (
              <div key={rule.label} className="risk-rule-row">
                <div className={cx('risk-rule-check', rule.enabled ? 'is-on' : 'is-off')}>
                  {rule.enabled ? <Check size={12} /> : <X size={12} />}
                </div>
                <div className="risk-rule-body">
                  <div className="risk-rule-label">{rule.label}</div>
                  <div className="risk-rule-desc">{rule.desc}</div>
                </div>
                <div className="risk-rule-value">{rule.value}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Kill switch logic */}
      <div className="panel risk-kill-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">02 / emergency protocol</div>
            <h2 className="card-title">Kill switch sequence</h2>
          </div>
          <div className="kill-switch-badge">
            <Zap size={11} /> CRIMSON PROTOCOL
          </div>
        </div>
        <p className="risk-kill-intro">
          When the kill switch is triggered, the following actions execute in order. No partial state is possible — all steps run atomically.
        </p>
        <div className="risk-kill-steps">
          {KILL_SWITCH_STEPS.map((step) => (
            <div key={step.n} className="risk-kill-step">
              <div className="risk-kill-step-num">{step.n}</div>
              <div>
                <div className="risk-kill-step-label">{step.label}</div>
                <div className="risk-kill-step-desc">{step.desc}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="risk-kill-note">
          <ShieldCheck size={13} />
          <span>The kill switch is always accessible from the top navigation bar. It requires explicit confirmation — type <strong>HALT</strong> or click <strong>CONFIRM FLATTEN</strong>.</span>
        </div>
      </div>

      {/* Paper lock card */}
      <div className="panel risk-paper-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">03 / execution boundary</div>
            <h2 className="card-title">Paper trading lock</h2>
          </div>
          <div className="status-chip is-good"><span />Active</div>
        </div>
        <div className="risk-paper-body">
          <div className="risk-paper-url">
            <span className="eyebrow">Enforced endpoint</span>
            <code>https://paper-api.alpaca.markets</code>
          </div>
          <p className="risk-paper-desc">
            The API server hard-codes <code>PAPER_TRADING_URL</code> to the Alpaca paper endpoint. There is no configuration path that routes orders to the live endpoint. If the server detects any other base URL, the UI locks all execution controls.
          </p>
        </div>
      </div>
    </div>
  );
}
