import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity, AlertTriangle, Check, ChevronRight, Play, RefreshCw,
  Shield, ShieldCheck, Zap, X, Brain, BarChart3, TrendingUp,
  ArrowRight, CircleDot,
} from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

const STEP_LABELS = [
  'Market Ingestion',
  'Multi-Indicator Analysis',
  'AI Thesis Generation',
  'Deterministic Risk Gates',
  'Trade Proposal',
  'Alpaca Paper Execution',
  'Post-Run Result',
];

const STEP_ICONS = [Activity, BarChart3, Brain, Shield, TrendingUp, Zap, Check];

type StepStatus = 'pending' | 'active' | 'success' | 'rejected';

type StepState = {
  status: StepStatus;
  durationMs?: number;
  detail?: Record<string, unknown>;
  error?: string;
};

type PipelineEvent = {
  step?: number;
  status?: string;
  label?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
  error?: string;
  done?: boolean;
  verdict?: string;
  reason?: string;
};

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'AAPL'];

export function ConsolePage() {
  const [symbol, setSymbol] = useState('SPY');
  const [customSymbol, setCustomSymbol] = useState('');
  const [strategyMode, setStrategyMode] = useState<'zscore' | 'ict_hmm'>('zscore');
  const [steps, setSteps] = useState<StepState[]>(Array(7).fill({ status: 'pending' }));
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<{ verdict: string; reason: string } | null>(null);
  const [inspectorData, setInspectorData] = useState<Record<number, Record<string, unknown>>>({});
  const [activeInspectorStep, setActiveInspectorStep] = useState<number | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const activeSymbol = customSymbol.trim().toUpperCase() || symbol;

  function resetPipeline() {
    setSteps(Array(7).fill({ status: 'pending' }));
    setVerdict(null);
    setInspectorData({});
    setActiveInspectorStep(null);
  }

  function runPipeline() {
    if (running) return;
    resetPipeline();
    setRunning(true);

    const idempotencyKey = crypto.randomUUID();
    const params = new URLSearchParams({
      symbol: activeSymbol,
      strategyMode,
      idempotencyKey,
    });

    const base = (window as any).__API_BASE__ ?? '/api';
    const es = new EventSource(`${base}/agent/console/stream?${params}`);
    esRef.current = es;

    es.onmessage = (e) => {
      try {
        const event: PipelineEvent = JSON.parse(e.data);
        if (event.done) {
          setVerdict({ verdict: event.verdict ?? 'REJECTED', reason: event.reason ?? '' });
          setRunning(false);
          es.close();
          return;
        }
        if (event.step != null) {
          const idx = event.step - 1;
          setSteps((prev) => {
            const next = [...prev];
            next[idx] = {
              status: (event.status as StepStatus) ?? 'active',
              durationMs: event.durationMs,
              detail: event.detail,
              error: event.error,
            };
            return next;
          });
          if (event.detail && Object.keys(event.detail).length > 0) {
            setInspectorData((prev) => ({ ...prev, [event.step!]: event.detail! }));
            setActiveInspectorStep(event.step!);
          }
        }
      } catch {}
    };

    es.onerror = () => {
      setRunning(false);
      setVerdict({ verdict: 'REJECTED', reason: 'Connection to pipeline stream lost.' });
      es.close();
    };
  }

  useEffect(() => () => { esRef.current?.close(); }, []);

  const currentInspector = activeInspectorStep != null ? inspectorData[activeInspectorStep] : null;

  return (
    <div className="console-layout">
      {/* Left: pipeline */}
      <div className="console-left">
        {/* Asset + controls */}
        <div className="panel console-controls">
          <div className="card-header">
            <div>
              <div className="eyebrow">01 / asset selector</div>
              <h2 className="card-title">Configure pipeline run</h2>
            </div>
            <div className="console-mode-toggle">
              <button
                className={cx('console-mode-btn', strategyMode === 'zscore' && 'is-active')}
                onClick={() => setStrategyMode('zscore')}
              >Z-score</button>
              <button
                className={cx('console-mode-btn', strategyMode === 'ict_hmm' && 'is-active')}
                onClick={() => setStrategyMode('ict_hmm')}
              >ICT / HMM</button>
            </div>
          </div>
          <div className="console-symbol-row">
            {DEFAULT_SYMBOLS.map((s) => (
              <button
                key={s}
                className={cx('console-symbol-chip', symbol === s && !customSymbol && 'is-active')}
                onClick={() => { setSymbol(s); setCustomSymbol(''); }}
              >{s}</button>
            ))}
            <input
              className="console-symbol-input"
              placeholder="Custom…"
              value={customSymbol}
              onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
              maxLength={8}
            />
          </div>
          <div className="console-run-row">
            <div className="console-active-symbol">
              <CircleDot size={12} />
              <span>Running on <strong>{activeSymbol}</strong> · {strategyMode === 'ict_hmm' ? 'ICT/HMM 5-cluster' : 'Z-score + ADX'}</span>
            </div>
            <button
              className="button button-primary"
              onClick={runPipeline}
              disabled={running}
            >
              {running ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />}
              {running ? 'Running…' : 'Run Agent Cycle'}
            </button>
          </div>
        </div>

        {/* Pipeline stepper */}
        <div className="panel pipeline-stepper">
          <div className="card-header">
            <div>
              <div className="eyebrow">02 / execution pipeline</div>
              <h2 className="card-title">Agent state machine</h2>
            </div>
            {running && (
              <div className="status-chip is-good">
                <span /><span className="font-mono text-[9px]">ANALYZING</span>
              </div>
            )}
          </div>
          <div className="pipeline-steps">
            {STEP_LABELS.map((label, i) => {
              const step = steps[i] ?? { status: 'pending' };
              const Icon = STEP_ICONS[i];
              const isLast = i === STEP_LABELS.length - 1;
              return (
                <div key={label} className="pipeline-step-wrap">
                  <motion.div
                    className={cx('pipeline-step', `is-${step.status}`)}
                    onClick={() => step.detail && setActiveInspectorStep(i + 1)}
                    animate={step.status === 'active' ? { boxShadow: ['0 0 0 0 rgba(16,185,129,0)', '0 0 0 6px rgba(16,185,129,0.18)', '0 0 0 0 rgba(16,185,129,0)'] } : {}}
                    transition={{ duration: 1.4, repeat: Infinity }}
                  >
                    <div className="pipeline-step-icon">
                      {step.status === 'active' ? <RefreshCw size={14} className="animate-spin" /> :
                       step.status === 'success' ? <Check size={14} /> :
                       step.status === 'rejected' ? <X size={14} /> :
                       <Icon size={14} />}
                    </div>
                    <div className="pipeline-step-body">
                      <div className="pipeline-step-num">Step {i + 1}</div>
                      <div className="pipeline-step-label">{label}</div>
                      {step.status === 'success' && step.durationMs != null && (
                        <div className="pipeline-step-duration">{step.durationMs}ms</div>
                      )}
                      {step.status === 'rejected' && step.error && (
                        <div className="pipeline-step-error">{step.error}</div>
                      )}
                    </div>
                    {step.detail && Object.keys(step.detail).length > 0 && (
                      <ChevronRight size={12} className="pipeline-step-chevron" />
                    )}
                  </motion.div>
                  {!isLast && <div className={cx('pipeline-connector', step.status === 'success' && 'is-done')} />}
                </div>
              );
            })}
          </div>

          {/* Verdict banner */}
          <AnimatePresence>
            {verdict && (
              <motion.div
                className={cx('verdict-banner', verdict.verdict === 'APPROVED' ? 'is-approved' : 'is-rejected')}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
              >
                {verdict.verdict === 'APPROVED'
                  ? <><Check size={15} /><span>TRADE APPROVED → PAPER ORDER SUBMITTED</span></>
                  : <><AlertTriangle size={15} /><span>TRADE REJECTED → {verdict.reason}</span></>}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Right: Decision Inspector */}
      <div className="console-right">
        <div className="panel decision-inspector">
          <div className="card-header">
            <div>
              <div className="eyebrow">03 / decision inspector</div>
              <h2 className="card-title">
                {activeInspectorStep ? `Step ${activeInspectorStep} — ${STEP_LABELS[activeInspectorStep - 1]}` : 'Awaiting pipeline run'}
              </h2>
            </div>
          </div>

          {!currentInspector && !running && (
            <div className="inspector-empty">
              <Brain size={28} className="inspector-empty-icon" />
              <p>Run the agent cycle to inspect each decision step in real time.</p>
            </div>
          )}

          {currentInspector && (
            <div className="inspector-body">
              {/* Step 2: indicators */}
              {activeInspectorStep === 2 && (
                <IndicatorBox data={currentInspector} />
              )}
              {/* Step 3: thesis */}
              {activeInspectorStep === 3 && (
                <ThesisCard data={currentInspector} />
              )}
              {/* Step 4: risk gates */}
              {activeInspectorStep === 4 && (
                <RiskGatesGrid data={currentInspector} />
              )}
              {/* Step 5: proposal */}
              {activeInspectorStep === 5 && (
                <ProposalCard data={currentInspector} />
              )}
              {/* Step 6: execution */}
              {activeInspectorStep === 6 && (
                <ExecutionCard data={currentInspector} />
              )}
              {/* Step 7 / other */}
              {(activeInspectorStep === 7 || (activeInspectorStep != null && activeInspectorStep < 2)) && (
                <GenericDetail data={currentInspector} />
              )}

              {/* Step nav */}
              <div className="inspector-step-nav">
                {Object.keys(inspectorData).map(Number).sort((a, b) => a - b).map((s) => (
                  <button
                    key={s}
                    className={cx('inspector-step-dot', activeInspectorStep === s && 'is-active')}
                    onClick={() => setActiveInspectorStep(s)}
                  >{s}</button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IndicatorBox({ data }: { data: Record<string, unknown> }) {
  const items = [
    { label: 'Z-Score', value: typeof data.zScore === 'number' ? `${data.zScore >= 0 ? '+' : ''}${(data.zScore as number).toFixed(2)}σ` : '—' },
    { label: 'ADX', value: typeof data.adx === 'number' ? (data.adx as number).toFixed(1) : '—' },
    { label: 'Volume Ratio', value: typeof data.volumeRatio === 'number' ? `${(data.volumeRatio as number).toFixed(2)}x` : '—' },
    { label: 'Regime', value: String(data.regime ?? '—') },
    { label: 'Cluster', value: String(data.cluster ?? '—') },
  ];
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">Indicator Evidence</div>
      <div className="inspector-kv-grid">
        {items.map(({ label, value }) => (
          <div key={label} className="inspector-kv">
            <span>{label}</span><strong>{value}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThesisCard({ data }: { data: Record<string, unknown> }) {
  const direction = String(data.direction ?? 'NEUTRAL');
  const confidence = Number(data.confidence ?? 0);
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">AI Market Thesis</div>
      <div className={cx('direction-pill', direction === 'BULLISH' ? 'is-bull' : direction === 'BEARISH' ? 'is-bear' : 'is-neutral')}>
        {direction}
      </div>
      <p className="thesis-text">{String(data.thesis ?? '—')}</p>
      <div className="confidence-meter">
        <div className="confidence-label">
          <span>Confidence</span><span>{confidence}%</span>
        </div>
        <div className="confidence-track">
          <motion.div
            className="confidence-fill"
            initial={{ width: 0 }}
            animate={{ width: `${confidence}%` }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
          />
        </div>
      </div>
    </div>
  );
}

function RiskGatesGrid({ data }: { data: Record<string, unknown> }) {
  const gates = (data.gates as Array<{ rule: string; passed: boolean; value: string }>) ?? [];
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">Risk Evaluation</div>
      <div className="risk-gates-list">
        {gates.map((g) => (
          <div key={g.rule} className={cx('risk-gate-row', g.passed ? 'is-pass' : 'is-fail')}>
            <div className="risk-gate-icon">{g.passed ? <Check size={11} /> : <X size={11} />}</div>
            <div className="risk-gate-rule">{g.rule}</div>
            <div className="risk-gate-value">{g.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProposalCard({ data }: { data: Record<string, unknown> }) {
  if (data.side === 'NONE') {
    return (
      <div className="inspector-section">
        <div className="inspector-section-label">Trade Proposal</div>
        <div className="inspector-empty-inline">No entry signal — {String(data.reason ?? '')}</div>
      </div>
    );
  }
  const items = [
    { label: 'Side', value: String(data.side ?? '—') },
    { label: 'Position %', value: `${data.positionPct ?? '—'}%` },
    { label: 'Position $', value: typeof data.positionUsd === 'number' ? `$${(data.positionUsd as number).toLocaleString()}` : '—' },
    { label: 'Qty', value: String(data.qty ?? '—') },
    { label: 'Stop-Loss', value: typeof data.stopLoss === 'number' ? `$${(data.stopLoss as number).toFixed(2)}` : '—' },
    { label: 'Take-Profit', value: typeof data.takeProfit === 'number' ? `$${(data.takeProfit as number).toFixed(2)}` : '—' },
  ];
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">Proposed Parameters</div>
      <div className="inspector-kv-grid">
        {items.map(({ label, value }) => (
          <div key={label} className="inspector-kv"><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
    </div>
  );
}

function ExecutionCard({ data }: { data: Record<string, unknown> }) {
  if (data.skipped) {
    return (
      <div className="inspector-section">
        <div className="inspector-section-label">Execution</div>
        <div className="inspector-empty-inline">Skipped — {String(data.reason ?? '')}</div>
      </div>
    );
  }
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">Alpaca Paper Execution</div>
      <div className="inspector-kv-grid">
        <div className="inspector-kv"><span>Order ID</span><strong className="font-mono text-[10px]">{String(data.orderId ?? '—')}</strong></div>
        <div className="inspector-kv"><span>Status</span><strong>{String(data.status ?? '—')}</strong></div>
        <div className="inspector-kv"><span>Side</span><strong>{String(data.side ?? '—')}</strong></div>
        <div className="inspector-kv"><span>Idempotency Key</span><strong className="font-mono text-[9px] break-all">{String(data.idempotencyKey ?? '—')}</strong></div>
      </div>
    </div>
  );
}

function GenericDetail({ data }: { data: Record<string, unknown> }) {
  return (
    <div className="inspector-section">
      <div className="inspector-section-label">Detail</div>
      <div className="inspector-kv-grid">
        {Object.entries(data).map(([k, v]) => (
          <div key={k} className="inspector-kv">
            <span>{k}</span><strong>{String(v ?? '—')}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}
