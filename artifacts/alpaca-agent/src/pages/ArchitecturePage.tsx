import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Database, Brain, Shield, Zap, BarChart3 } from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type ArchNode = {
  id: string;
  label: string;
  role: string;
  icon: React.ElementType;
  model: string;
  inputSchema: string;
  outputSchema: string;
  tools: string[];
  x: number;
  y: number;
  color: string;
};

const NODES: ArchNode[] = [
  {
    id: 'analyst',
    label: 'Market Analyst',
    role: 'Ingests OHLCV bars, computes Z-score, SMA, stddev, ADX, volume ratio, and regime classification.',
    icon: BarChart3,
    model: 'ZScore-ADX / ICT-HMM-5cluster',
    inputSchema: '{ symbol: string, bars: Bar[], strategyMode: "zscore"|"ict_hmm" }',
    outputSchema: '{ zScore, adx, volumeRatio, regime, cluster, signal }',
    tools: ['Alpaca Market Data API', 'Technical Indicator Engine', 'HMM Regime Classifier'],
    x: 80, y: 160, color: '#10B981',
  },
  {
    id: 'strategy',
    label: 'Strategy Generator',
    role: 'Synthesises indicator evidence into a directional thesis and entry/exit signal with confidence score.',
    icon: Brain,
    model: 'Deterministic rule engine (no LLM)',
    inputSchema: '{ snapshot: SymbolSnapshot, guardrails: GuardrailState }',
    outputSchema: '{ signal, thesis, direction, confidence, positionPct, stopLoss, takeProfit }',
    tools: ['Z-score band classifier', 'ICT/SMC feature extractor', '5-cluster router (AWD gate)'],
    x: 310, y: 80, color: '#A78BFA',
  },
  {
    id: 'risk',
    label: 'Risk Agent',
    role: 'Applies all deterministic guardrails. Any single gate failure blocks the order. Paper lock is always enforced.',
    icon: Shield,
    model: 'Deterministic gate engine',
    inputSchema: '{ signal, snapshot, guardrails, positions }',
    outputSchema: '{ approved: boolean, gates: RiskGate[], blockedReason?: string }',
    tools: ['Volume filter', 'ADX gate', 'Duplicate position check', 'Hard invalidation', 'Trailing stop', 'Paper-only lock'],
    x: 310, y: 260, color: '#F59E0B',
  },
  {
    id: 'execution',
    label: 'Execution Agent',
    role: 'Submits paper orders to Alpaca with idempotency key. Handles demo simulation when credentials are absent.',
    icon: Zap,
    model: 'Alpaca REST adapter',
    inputSchema: '{ symbol, side, qty, idempotencyKey, dryRun }',
    outputSchema: '{ orderId, status: "submitted"|"simulated", at }',
    tools: ['Alpaca Paper Trading API', 'Idempotency key store', 'Demo position simulator'],
    x: 540, y: 160, color: '#10B981',
  },
  {
    id: 'evaluator',
    label: 'Evaluator / Memory',
    role: 'Records every decision as an immutable audit run with full raw JSON payloads. Feeds the activity log and audit trail.',
    icon: Database,
    model: 'In-memory audit store',
    inputSchema: '{ activity, marketSnapshot, modelOutput, riskResult, alpacaResponse }',
    outputSchema: '{ auditRun: AuditRun, activities: StrategyActivity[] }',
    tools: ['Audit run store (100 records)', 'Activity log (40 records)', 'Trailing extremes map'],
    x: 540, y: 320, color: '#38BDF8',
  },
];

const EDGES = [
  { from: 'analyst', to: 'strategy' },
  { from: 'analyst', to: 'risk' },
  { from: 'strategy', to: 'risk' },
  { from: 'risk', to: 'execution' },
  { from: 'execution', to: 'evaluator' },
  { from: 'risk', to: 'evaluator' },
];

const NODE_W = 130;
const NODE_H = 56;

function nodeCenter(n: ArchNode) {
  return { cx: n.x + NODE_W / 2, cy: n.y + NODE_H / 2 };
}

export function ArchitecturePage() {
  const [selected, setSelected] = useState<ArchNode | null>(null);

  return (
    <div className="arch-layout">
      <div className="panel arch-graph-panel">
        <div className="card-header">
          <div>
            <div className="eyebrow">01 / multi-agent system</div>
            <h2 className="card-title">Agent workflow graph</h2>
          </div>
          <span className="font-mono text-[9px] text-muted-foreground uppercase tracking-widest">Click a node to inspect</span>
        </div>
        <div className="arch-graph-wrap">
          <svg viewBox="0 0 720 420" className="arch-svg" aria-label="Agent workflow graph">
            <defs>
              <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                <path d="M0,0 L0,6 L8,3 z" fill="rgba(255,255,255,0.2)" />
              </marker>
            </defs>
            {/* Edges */}
            {EDGES.map((edge) => {
              const from = NODES.find((n) => n.id === edge.from)!;
              const to = NODES.find((n) => n.id === edge.to)!;
              const f = nodeCenter(from);
              const t = nodeCenter(to);
              return (
                <line
                  key={`${edge.from}-${edge.to}`}
                  x1={f.cx} y1={f.cy}
                  x2={t.cx} y2={t.cy}
                  stroke="rgba(255,255,255,0.15)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  markerEnd="url(#arrow)"
                />
              );
            })}
            {/* Nodes */}
            {NODES.map((node) => {
              const Icon = node.icon;
              const isSelected = selected?.id === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x},${node.y})`}
                  onClick={() => setSelected(isSelected ? null : node)}
                  style={{ cursor: 'pointer' }}
                >
                  <rect
                    width={NODE_W} height={NODE_H}
                    rx={6}
                    fill={isSelected ? node.color + '33' : 'rgba(255,255,255,0.04)'}
                    stroke={isSelected ? node.color : 'rgba(255,255,255,0.12)'}
                    strokeWidth={isSelected ? 2 : 1}
                  />
                  <foreignObject x={8} y={8} width={NODE_W - 16} height={NODE_H - 16}>
                    <div className="arch-node-inner">
                      <div className="arch-node-label" style={{ color: isSelected ? node.color : '#e4e4e7' }}>
                        {node.label}
                      </div>
                    </div>
                  </foreignObject>
                </g>
              );
            })}
          </svg>
        </div>
      </div>

      {/* Node inspector sheet */}
      <AnimatePresence>
        {selected && (
          <motion.div
            className="arch-inspector"
            initial={{ opacity: 0, x: 32 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 32 }}
            transition={{ duration: 0.22 }}
          >
            <div className="arch-inspector-head">
              <div>
                <div className="eyebrow">Node inspector</div>
                <div className="arch-inspector-title" style={{ color: selected.color }}>{selected.label}</div>
              </div>
              <button className="icon-button" onClick={() => setSelected(null)} aria-label="Close inspector">
                <X size={15} />
              </button>
            </div>

            <p className="arch-inspector-role">{selected.role}</p>

            <div className="arch-inspector-section">
              <div className="eyebrow mb-2">Model / Engine</div>
              <code className="arch-code">{selected.model}</code>
            </div>

            <div className="arch-inspector-section">
              <div className="eyebrow mb-2">Input Schema</div>
              <pre className="arch-schema">{selected.inputSchema}</pre>
            </div>

            <div className="arch-inspector-section">
              <div className="eyebrow mb-2">Output Schema</div>
              <pre className="arch-schema">{selected.outputSchema}</pre>
            </div>

            <div className="arch-inspector-section">
              <div className="eyebrow mb-2">External Tools</div>
              <ul className="arch-tools-list">
                {selected.tools.map((t) => (
                  <li key={t}><span className="arch-tool-dot" />  {t}</li>
                ))}
              </ul>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
