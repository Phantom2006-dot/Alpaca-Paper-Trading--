import { type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  BrainCircuit,
  Check,
  ChevronRight,
  Clock3,
  Command,
  Crosshair,
  Database,
  Info,
  LayoutDashboard,
  LifeBuoy,
  ListChecks,
  LockKeyhole,
  Menu,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  TrendingUp,
  Unplug,
  WalletCards,
  X,
  Zap,
  ArrowRight,
  Brain,
  LineChart,
  Shield,
  Layers,
  GitBranch,
  Eye,
  Star,
  Sparkles,
  CircleCheck,
  Rocket,
  Building2,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getGetAgentDashboardQueryKey,
  getGetAgentStatusQueryKey,
  getGetMarketSnapshotQueryKey,
  getGetAgentAccountQueryKey,
  getGetAgentAssetsQueryKey,
  useGetAgentAccount,
  useGetAgentAssets,
  useFlattenAgentPositions,
  useGetAgentDashboard,
  useGetAgentStatus,
  useGetMarketSnapshot,
  useHealthCheck,
  useOptimizeBacktest,
  useRunBacktest,
  useRunStrategy,
  useStartAgent,
  useStopAgent,
} from '@workspace/api-client-react';
import type {
  AgentDashboard,
  AgentStatus,
  AgentAccountOverview,
  BacktestInputFeed,
  BacktestInputTimeframe,
  BacktestResult,
  OptimizationResult,
  GuardrailState,
  StrategyActivity,
  SymbolSnapshot,
  TradableAsset,
} from '@workspace/api-client-react';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import { ConsolePage } from '@/pages/ConsolePage';
import { AuditPage } from '@/pages/AuditPage';
import { RiskPage } from '@/pages/RiskPage';
import { ArchitecturePage } from '@/pages/ArchitecturePage';
import { KillSwitchModal } from '@/components/KillSwitchModal';

const queryClient = new QueryClient();

const navItems = [
  { href: '/dashboard', label: 'Dashboard', short: 'DASH', icon: LayoutDashboard },
  { href: '/console', label: 'AI Console', short: 'CONSOLE', icon: BrainCircuit },
  { href: '/strategy', label: 'Strategy logic', short: 'LOGIC', icon: SlidersHorizontal },
  { href: '/backtest', label: 'Backtester', short: 'TEST', icon: Database },
  { href: '/audit', label: 'Audit trail', short: 'AUDIT', icon: ListChecks },
  { href: '/risk', label: 'Risk engine', short: 'RISK', icon: ShieldCheck },
  { href: '/account', label: 'Account & orders', short: 'ACCOUNT', icon: WalletCards },
  { href: '/architecture', label: 'Architecture', short: 'ARCH', icon: GitBranch },
];

const fallbackSnapshots: SymbolSnapshot[] = [];

function cx(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

function formatTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

function formatDateTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function money(value = 0, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

function pct(value = 0, digits = 2) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

function dateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

function z(value = 0) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}σ`;
}

function statusLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function AppLogo() {
  return (
    <div className="flex items-center gap-3">
      <div className="logo-mark" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div>
        <div className="font-display text-[15px] font-bold tracking-[-0.03em] text-sidebar-foreground">alpaca</div>
        <div className="font-mono text-[9px] uppercase tracking-[0.24em] text-sidebar-foreground/45">agent / r1</div>
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [mobileNav, setMobileNav] = useState(false);
  const [killOpen, setKillOpen] = useState(false);
  const [killHalted, setKillHalted] = useState(false);
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 } });
  const healthQuery = useHealthCheck({ query: { queryKey: ['health-check'], refetchInterval: 30000 } });
  const flatten = useFlattenAgentPositions();
  const stopAgent = useStopAgent();
  const queryClient = useQueryClient();
  const status = statusQuery.data;
  const isDemo = status?.mode === 'demo';
  const isPaperHealthy = status?.mode === 'paper' && status.connected;
  const healthOk = healthQuery.data?.status === 'ok' || healthQuery.data?.status === 'healthy';

  const agentStatusLabel = killHalted ? 'HALTED' : status?.running ? 'ANALYZING' : status?.connected ? 'ONLINE' : 'IDLE';
  const agentStatusClass = killHalted ? 'is-halted' : status?.running ? 'is-analyzing' : status?.connected ? 'is-online' : 'is-idle';

  function handleKillConfirm() {
    flatten.mutate(undefined, {
      onSuccess: () => {
        stopAgent.mutate(undefined, {
          onSuccess: () => {
            setKillHalted(true);
            setKillOpen(false);
            queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
            queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
          },
        });
      },
    });
  }

  return (
    <div className={cx('min-h-[100dvh] bg-background text-foreground', killHalted && 'is-halted-state')}>
      <KillSwitchModal
        open={killOpen}
        onClose={() => setKillOpen(false)}
        onConfirm={handleKillConfirm}
        pending={flatten.isPending || stopAgent.isPending}
      />
      {killHalted && (
        <div className="halt-banner">
          <AlertTriangle size={14} />
          <span>AGENT HALTED — All positions flattened. Restart the agent to resume operations.</span>
          <button onClick={() => setKillHalted(false)} className="halt-banner-dismiss"><X size={13} /></button>
        </div>
      )}
      <aside className={cx('app-sidebar', mobileNav && 'is-open')}>
        <div className="flex items-center justify-between px-5 py-5 lg:block lg:px-7 lg:py-7">
          <Link href="/dashboard" className="inline-flex" data-testid="link-sidebar-logo">
            <AppLogo />
          </Link>
          <button className="mobile-menu-button" onClick={() => setMobileNav(false)} data-testid="button-close-navigation">
            <X size={18} />
          </button>
        </div>
        <div className="sidebar-rule" />
        <div className="px-4 py-4 lg:px-4">
          <div className="mb-3 px-3 font-mono text-[9px] font-medium uppercase tracking-[0.2em] text-sidebar-foreground/35">Workspace</div>
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = location === item.href;
              return (
                <Link
                  href={item.href}
                  key={item.href}
                  onClick={() => setMobileNav(false)}
                  className={cx('sidebar-link', active && 'is-active')}
                  data-testid={`link-nav-${item.short.toLowerCase()}`}
                >
                  <Icon size={16} strokeWidth={active ? 2.4 : 1.8} />
                  <span>{item.label}</span>
                  {active && <span className="sidebar-active-dot" />}
                </Link>
              );
            })}
          </nav>
        </div>
        <div className="mt-auto hidden px-5 pb-6 lg:block">
          <div className="sidebar-rule mb-5" />
          <div className="mb-3 flex items-center gap-2 px-2 font-mono text-[9px] uppercase tracking-[0.18em] text-sidebar-foreground/40">
            <span className={cx('heartbeat-dot', healthOk && 'is-live')} />
            {healthQuery.isLoading ? 'checking core' : healthOk ? 'core operational' : 'core unavailable'}
          </div>
          <div className="flex items-center justify-between rounded-sm border border-sidebar-border bg-sidebar-accent/50 px-3 py-3">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-sidebar-foreground/40">Execution</div>
              <div className="mt-1 text-xs font-semibold text-sidebar-foreground">{isDemo ? 'Demo simulation' : isPaperHealthy ? 'Paper account' : 'Paper needs attention'}</div>
            </div>
            <ShieldCheck size={17} className={isDemo ? 'text-sidebar-foreground/40' : 'text-sidebar-primary'} />
          </div>
        </div>
      </aside>
      {mobileNav && <button className="mobile-nav-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation" data-testid="button-navigation-scrim" />}
      <main className="app-main">
        <header className="topbar">
          <div className="flex items-center gap-3">
            <button className="mobile-menu-button mobile-menu-open" onClick={() => setMobileNav(true)} data-testid="button-open-navigation">
              <Menu size={19} />
            </button>
            <div className="topbar-breadcrumb">
              <span>ALPACA AGENT</span>
              <ChevronRight size={12} />
              <strong>{navItems.find((item) => item.href === location)?.short ?? (location === '/dashboard' ? 'DASH' : 'DASH')}</strong>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Paper trading badge — always visible */}
            <div className="paper-badge" data-testid="badge-paper-trading">
              🟡 PAPER TRADING ONLY
            </div>
            {/* Agent status badge */}
            <div className={cx('agent-status-badge', agentStatusClass)} data-testid="badge-agent-status">
              <span className="agent-status-dot" />
              {agentStatusLabel}
            </div>
            <div className="topbar-divider" />
            {/* Mode pill */}
            <div className={cx('mode-pill', isDemo ? 'is-demo' : 'is-paper')} data-testid="status-execution-mode">
              <span className="mode-pill-dot" />
              {statusQuery.isLoading ? 'SYNCING' : isDemo ? 'DEMO' : isPaperHealthy ? 'PAPER' : 'ATTENTION'}
            </div>
            <div className="topbar-divider" />
            {/* Kill switch */}
            <button
              className="kill-switch-btn"
              onClick={() => setKillOpen(true)}
              disabled={killHalted}
              data-testid="button-kill-switch"
            >
              🛑 KILL
            </button>
          </div>
        </header>
        <div className="page-wrap">{children}</div>
      </main>
    </div>
  );
}

function PageIntro({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-intro">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1 className="page-title">{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action}
    </div>
  );
}

function CardHeader({ eyebrow, title, action }: { eyebrow?: string; title: string; action?: ReactNode }) {
  return (
    <div className="card-header">
      <div>
        {eyebrow && <div className="eyebrow mb-1">{eyebrow}</div>}
        <h2 className="card-title">{title}</h2>
      </div>
      {action}
    </div>
  );
}

function LoadingPanel({ rows = 4 }: { rows?: number }) {
  return (
    <div className="panel p-5" data-testid="state-loading-dashboard">
      <div className="skeleton-line mb-5 h-4 w-40" />
      <div className="space-y-3">
        {Array.from({ length: rows }).map((_, index) => (
          <div className="flex items-center gap-4" key={index}>
            <div className="skeleton-line h-8 w-8" />
            <div className="flex-1">
              <div className="skeleton-line mb-2 h-3 w-2/5" />
              <div className="skeleton-line h-2 w-3/5" />
            </div>
            <div className="skeleton-line h-3 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorPanel({ onRetry, compact = false }: { onRetry: () => void; compact?: boolean }) {
  return (
    <div className={cx('panel error-panel', compact ? 'p-5' : 'p-8')} data-testid="state-error-dashboard">
      <div className="error-icon"><AlertTriangle size={18} /></div>
      <div className="min-w-0">
        <div className="font-display text-sm font-bold">Agent data is out of reach</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">The cockpit could not load the latest state. Retry before acting.</div>
      </div>
      <button className="button button-secondary ml-auto shrink-0" onClick={onRetry} data-testid="button-retry-dashboard">
        <RefreshCw size={13} /> Retry
      </button>
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty-state" data-testid="state-empty-content">
      <div className="empty-state-mark"><Crosshair size={19} /></div>
      <div className="font-display text-sm font-bold">{title}</div>
      <p className="mt-1 max-w-sm text-center text-xs leading-relaxed text-muted-foreground">{description}</p>
    </div>
  );
}

function AssetPicker({ selected, onChange, max = 8 }: { selected: string[]; onChange: (symbols: string[]) => void; max?: number }) {
  const [search, setSearch] = useState('');
  const assetsQuery = useGetAgentAssets(
    { search: search || undefined },
    { query: { queryKey: getGetAgentAssetsQueryKey({ search: search || undefined }), staleTime: 60000 } },
  );
  const toggle = (symbol: string) => {
    const next = selected.includes(symbol) ? selected.filter((item) => item !== symbol) : selected.length < max ? [...selected, symbol] : selected;
    onChange(next);
  };
  return (
    <div className="asset-picker" data-testid="asset-picker">
      <div className="asset-picker-search">
        <Search size={13} />
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search Alpaca assets by symbol or name" data-testid="input-asset-search" />
        {assetsQuery.isFetching && <RefreshCw size={12} className="animate-spin text-muted-foreground" />}
      </div>
      <div className="asset-chips">
        {selected.map((symbol) => <button className="asset-chip" key={symbol} onClick={() => toggle(symbol)} type="button">{symbol}<X size={11} /></button>)}
        {!selected.length && <span className="text-[10px] text-muted-foreground">No assets selected</span>}
      </div>
      <div className="asset-results">
        {assetsQuery.data?.slice(0, 12).map((asset: TradableAsset) => (
          <button type="button" className={cx('asset-result', selected.includes(asset.symbol) && 'is-selected')} key={asset.symbol} onClick={() => toggle(asset.symbol)} disabled={!selected.includes(asset.symbol) && selected.length >= max} data-testid={`button-asset-${asset.symbol}`}>
            <span><strong>{asset.symbol}</strong><small>{asset.name}</small></span><span>{selected.includes(asset.symbol) ? <Check size={13} /> : asset.exchange}</span>
          </button>
        ))}
        {!assetsQuery.isLoading && !assetsQuery.data?.length && <span className="p-3 text-[10px] text-muted-foreground">No tradable assets match this search.</span>}
      </div>
      <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">{selected.length} / {max} selected · search blank to browse Alpaca’s available tradable assets</div>
    </div>
  );
}

function AccountStrip({ account }: { account: AgentDashboard['account'] }) {
  const values = [
    { label: 'Net equity', value: money(account.equity, account.currency), strong: true },
    { label: 'Available cash', value: money(account.cash, account.currency) },
    { label: 'Buying power', value: money(account.buyingPower, account.currency) },
    { label: 'Today', value: money(account.dayPnl, account.currency), sub: pct(account.dayPnlPct), positive: account.dayPnl >= 0 },
  ];
  return (
    <div className="account-strip" data-testid="panel-account-summary">
      {values.map((item) => (
        <div className="account-cell" key={item.label}>
          <div className="eyebrow">{item.label}</div>
          <div className={cx('account-value', item.strong && 'is-strong', item.positive === false && 'is-negative')}>
            {item.value}
            {item.sub && <span className={cx('account-sub', item.positive ? 'is-positive' : 'is-negative')}>{item.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function AgentStatusCard({
  status,
  onFlatten,
  flattenPending,
  onStart,
  onStop,
  startPending,
  stopPending,
  intervalSeconds,
  onIntervalChange,
}: {
  status: AgentStatus;
  onFlatten: () => void;
  flattenPending: boolean;
  onStart: () => void;
  onStop: () => void;
  startPending: boolean;
  stopPending: boolean;
  intervalSeconds: number;
  onIntervalChange: (value: number) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const enabledGuardrails = Object.entries(status.guardrails).filter(([key, value]) => typeof value === 'boolean' && value).length;
  return (
    <div className="panel status-card" data-testid="panel-agent-status">
      <CardHeader
        eyebrow="01 / agent state"
        title="Control surface"
        action={<div className={cx('status-chip', status.connected ? 'is-good' : 'is-warn')}><span />{status.connected ? 'Connected' : 'Disconnected'}</div>}
      />
      <div className="status-hero">
        <div className={cx('agent-orbit', status.connected && 'is-live')}>
          <div className="orbit-ring ring-one" />
          <div className="orbit-ring ring-two" />
          <div className="orbit-core"><Zap size={22} /></div>
        </div>
        <div>
          <div className="font-display text-xl font-bold tracking-[-0.04em]">{status.mode === 'demo' ? 'Simulation lane' : 'Paper lane'}</div>
          <div className="mt-1 text-xs text-muted-foreground">{status.paper ? 'Orders route to paper only.' : 'No brokerage execution active.'}</div>
        </div>
      </div>
      <div className="status-grid">
        <div><span>Last scan</span><strong>{formatDateTime(status.lastRunAt)}</strong></div>
        <div><span>Next scan</span><strong>{status.running ? formatDateTime(status.nextRunAt) : 'Agent stopped'}</strong></div>
        <div><span>Heartbeat</span><strong className="font-mono text-[11px]">{status.heartbeat || '—'}</strong></div>
        <div><span>Guardrails</span><strong>{enabledGuardrails} / 6 live</strong></div>
      </div>
      <div className="automation-control">
        <div>
          <div className="eyebrow">Continuous execution</div>
          <div className="automation-status">{status.running ? `Running every ${status.intervalSeconds}s · strategy decides` : 'Stopped · no orders will be submitted'}</div>
        </div>
        <div className="automation-actions">
          {!status.running && (
            <select value={intervalSeconds} onChange={(event) => onIntervalChange(Number(event.target.value))} aria-label="Agent scan cadence" data-testid="select-agent-interval">
              <option value={60}>Every 1 min</option>
              <option value={300}>Every 5 min</option>
              <option value={900}>Every 15 min</option>
              <option value={1800}>Every 30 min</option>
            </select>
          )}
          {status.running ? (
            <button className="button button-secondary" onClick={onStop} disabled={stopPending} data-testid="button-stop-agent">
              {stopPending ? <RefreshCw size={13} className="animate-spin" /> : <X size={13} />} Stop agent
            </button>
          ) : (
            <button className="button button-primary" onClick={onStart} disabled={startPending} data-testid="button-start-agent">
              {startPending ? <RefreshCw size={13} className="animate-spin" /> : <Play size={13} />} Start agent
            </button>
          )}
        </div>
      </div>
      {status.lastError && <div className="automation-error"><AlertTriangle size={13} /><span>Last cycle failed: {status.lastError}</span></div>}
      <div className="status-footer">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><LockKeyhole size={13} /> Paper-only lock engaged</div>
        {!confirm ? (
          <button className="button button-danger-ghost" onClick={() => setConfirm(true)} disabled={flattenPending} data-testid="button-open-flatten">
            <Unplug size={13} /> Flatten
          </button>
        ) : (
          <div className="flex items-center gap-1.5">
            <button className="button button-danger" onClick={() => { onFlatten(); setConfirm(false); }} disabled={flattenPending} data-testid="button-confirm-flatten">
              {flattenPending ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />} Confirm
            </button>
            <button className="icon-button" onClick={() => setConfirm(false)} aria-label="Cancel flatten" data-testid="button-cancel-flatten"><X size={14} /></button>
          </div>
        )}
      </div>
    </div>
  );
}

function MetricRail({ metrics }: { metrics: AgentDashboard['metrics'] }) {
  const items = [
    { label: 'Scans today', value: metrics.totalScans.toString().padStart(2, '0'), icon: RadarIcon },
    { label: 'Signals found', value: metrics.signalsToday.toString().padStart(2, '0'), icon: Crosshair },
    { label: 'Blocked by logic', value: metrics.blockedToday.toString().padStart(2, '0'), icon: ShieldCheck },
    { label: 'Open positions', value: metrics.openPositions.toString().padStart(2, '0'), icon: Activity },
    { label: 'Win rate', value: `${metrics.winRate.toFixed(1)}%`, icon: TrendingUp },
    { label: 'Avg hold', value: `${metrics.avgHoldHours.toFixed(1)}h`, icon: Clock3 },
  ];
  return (
    <div className="metric-rail" data-testid="panel-agent-metrics">
      {items.map((item) => {
        const Icon = item.icon;
        return <div className="metric-item" key={item.label}><Icon size={14} /><div><div className="metric-value">{item.value}</div><div className="metric-label">{item.label}</div></div></div>;
      })}
    </div>
  );
}

function RadarIcon({ size }: { size?: number }) {
  return <span className="radar-icon" style={{ width: size ?? 16, height: size ?? 16 }}><span /></span>;
}

function SignalBadge({ signal }: { signal: string }) {
  const good = signal === 'long_entry' || signal === 'short_entry';
  const warn = signal === 'blocked' || signal === 'invalidation';
  return <span className={cx('signal-badge', good ? 'is-signal' : warn ? 'is-blocked' : signal === 'exit' ? 'is-exit' : 'is-hold')}><span />{statusLabel(signal)}</span>;
}

function SnapshotTable({ snapshots, onSelect }: { snapshots: SymbolSnapshot[]; onSelect: (symbol: string) => void }) {
  return (
    <div className="panel overflow-hidden" data-testid="panel-symbol-scanner">
      <CardHeader
        eyebrow="02 / market scan"
        title="Symbol scanner"
        action={<div className="flex items-center gap-2 font-mono text-[10px] text-muted-foreground"><span className="heartbeat-dot is-live" /> {snapshots.length} instruments</div>}
      />
      {snapshots.length === 0 ? <EmptyState title="No symbols in the lane" description="Once the agent has a symbol universe, each indicator decision will appear here." /> : (
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>Symbol</th><th>Price</th><th>Z-score</th><th>ADX</th><th>Volume</th><th>Position</th><th>Signal</th><th>Cluster</th><th>State</th></tr></thead>
            <tbody>
              {snapshots.map((snapshot) => (
                <tr key={snapshot.symbol} onClick={() => onSelect(snapshot.symbol)} data-testid={`row-symbol-${snapshot.symbol}`}>
                  <td><button className="symbol-button" onClick={() => onSelect(snapshot.symbol)} data-testid={`button-symbol-${snapshot.symbol}`}><span className="symbol-avatar">{snapshot.symbol.slice(0, 1)}</span><span><strong>{snapshot.symbol}</strong><small>{statusLabel(snapshot.regime)}</small></span></button></td>
                  <td className="font-mono text-xs">${snapshot.price.toFixed(2)}</td>
                  <td><span className={cx('z-score', snapshot.zScore > 0 ? 'is-positive' : 'is-negative')}>{z(snapshot.zScore)}</span></td>
                  <td className="font-mono text-xs">{snapshot.adx.toFixed(1)}</td>
                  <td><div className="volume-cell"><span className="volume-bar"><i style={{ width: `${Math.min(snapshot.volumeRatio * 35, 100)}%` }} /></span><span>{snapshot.volumeRatio.toFixed(2)}x</span></div></td>
                  <td className="text-xs">{snapshot.positionQty ? `${snapshot.positionQty} ${snapshot.positionSide}` : 'Flat'}</td>
                  <td><SignalBadge signal={snapshot.signal} /></td>
                  <td className="font-mono text-[10px] text-muted-foreground">{(snapshot as any).cluster ?? '—'}</td>
                  <td><span className={cx('trade-state', snapshot.tradeBlockedReason ? 'is-blocked' : 'is-clear')}>{snapshot.tradeBlockedReason ? 'held' : 'clear'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ActivityList({ activity, compact = false }: { activity: StrategyActivity[]; compact?: boolean }) {
  return (
    <div className={cx('activity-list', compact && 'is-compact')} data-testid="list-recent-activity">
      {activity.length === 0 ? <EmptyState title="No decisions logged" description="Every scan decision and paper-order action will be recorded here." /> : activity.slice(0, compact ? 5 : undefined).map((item) => (
        <div className="activity-row" key={item.id} data-testid={`row-activity-${item.id}`}>
          <div className={cx('activity-marker', item.status === 'blocked' ? 'is-blocked' : item.status === 'submitted' ? 'is-submitted' : item.status === 'closed' ? 'is-closed' : 'is-simulated')}><Activity size={13} /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-mono text-[11px] font-medium uppercase text-foreground">{item.action}</span><span className="text-xs font-bold text-primary">{item.symbol}</span><span className="activity-status">{statusLabel(item.status)}</span></div>
            <div className="mt-1 truncate text-[11px] text-muted-foreground">{item.reason}</div>
          </div>
          <div className="ml-3 shrink-0 text-right"><div className={cx('font-mono text-[11px]', item.zScore >= 0 ? 'text-primary' : 'text-destructive')}>{z(item.zScore)}</div><div className="mt-1 font-mono text-[9px] text-muted-foreground">{formatTime(item.at)}</div></div>
        </div>
      ))}
    </div>
  );
}

function SymbolDetail({ symbol, onClose }: { symbol: string; onClose: () => void }) {
  const query = useGetMarketSnapshot(symbol, { query: { enabled: !!symbol, queryKey: getGetMarketSnapshotQueryKey(symbol) } });
  const snapshot = query.data;
  return (
    <div className="detail-drawer" data-testid="panel-symbol-detail">
      <div className="detail-drawer-head"><div><div className="eyebrow">Market detail</div><div className="font-display text-lg font-bold">{symbol}</div></div><button className="icon-button" onClick={onClose} aria-label="Close symbol detail" data-testid="button-close-symbol-detail"><X size={16} /></button></div>
      {query.isLoading ? <LoadingPanel rows={5} /> : query.isError ? <ErrorPanel compact onRetry={() => query.refetch()} /> : snapshot ? (
        <>
          <div className="detail-price"><span>${snapshot.price.toFixed(2)}</span><SignalBadge signal={snapshot.signal} /></div>
          <div className="detail-stat-grid">
            <div><span>SMA</span><strong>${snapshot.sma.toFixed(2)}</strong></div><div><span>Std dev</span><strong>{snapshot.stddev.toFixed(3)}</strong></div><div><span>Z-score</span><strong>{z(snapshot.zScore)}</strong></div><div><span>ADX</span><strong>{snapshot.adx.toFixed(1)}</strong></div><div><span>Vol ratio</span><strong>{snapshot.volumeRatio.toFixed(2)}x</strong></div><div><span>Unrealized</span><strong className={snapshot.unrealizedPnl >= 0 ? 'text-primary' : 'text-destructive'}>{money(snapshot.unrealizedPnl)}</strong></div>
          </div>
          <div className="detail-explain"><div className="eyebrow">Decision trace</div><p>{snapshot.tradeBlockedReason || `Signal ${statusLabel(snapshot.signal)} with ${statusLabel(snapshot.regime)} regime. All available indicators are visible for review.`}</p></div>
          <div className="mt-auto pt-5 font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">Updated {formatDateTime(snapshot.updatedAt)}</div>
        </>
      ) : <EmptyState title="No detail returned" description="This instrument has no current snapshot." />}
    </div>
  );
}

function DashboardPage() {
  const queryClient = useQueryClient();
  const dashboardQuery = useGetAgentDashboard({ query: { queryKey: getGetAgentDashboardQueryKey(), refetchInterval: 30000 } });
  const runStrategy = useRunStrategy();
  const flatten = useFlattenAgentPositions();
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [strategyMode, setStrategyMode] = useState<'zscore' | 'ict_hmm'>('zscore');
  const [intervalSeconds, setIntervalSeconds] = useState(300);
  const [notice, setNotice] = useState('');
  const dashboard = dashboardQuery.data;
  const snapshots = dashboard?.snapshots ?? fallbackSnapshots;
  const runScan = () => {
    if (!dashboard?.status.symbols?.length) {
      setNotice('No symbols are configured for this lane.');
      return;
    }
    setNotice('');
    runStrategy.mutate({ data: { symbols: dashboard.status.symbols, dryRun, strategyMode } as any }, {
      onSuccess: (result) => {
        setNotice(`Scan complete · ${result.evaluated} symbols evaluated · ${result.actions.length} actions`);
        queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
      },
      onError: () => setNotice('Scan could not be completed. Review the agent connection and retry.'),
    });
  };
  const flattenPositions = () => {
    flatten.mutate(undefined, {
      onSuccess: (result) => {
        setNotice(`${result.message} · ${result.closed} position${result.closed === 1 ? '' : 's'} closed`);
        queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
      },
      onError: () => setNotice('Flatten request failed. No positions were changed.'),
    });
  };
  const startContinuousAgent = () => {
    if (!dashboard?.status.symbols?.length) {
      setNotice('No symbols are configured for this lane.');
      return;
    }
    setNotice('');
    startAgent.mutate({ data: { symbols: dashboard.status.symbols, intervalSeconds, strategyMode } as any }, {
      onSuccess: (result) => {
        setNotice(result.message);
        queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
      },
      onError: () => setNotice('The agent could not start. No orders were submitted.'),
    });
  };
  const stopContinuousAgent = () => {
    setNotice('');
    stopAgent.mutate(undefined, {
      onSuccess: (result) => {
        setNotice(result.message);
        queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
        queryClient.invalidateQueries({ queryKey: getGetAgentStatusQueryKey() });
      },
      onError: () => setNotice('The agent could not be stopped. Check the API connection.'),
    });
  };
  return (
    <>
      <PageIntro
        eyebrow="Live agent / control room"
        title="Good decisions leave a trail."
        description="See what the agent sees, why it waits, and where every paper order came from."
        action={<div className="flex items-center gap-2">
          <select value={strategyMode} onChange={(e) => setStrategyMode(e.target.value as 'zscore' | 'ict_hmm')} aria-label="Strategy mode" data-testid="select-strategy-mode" className="text-xs border border-border rounded px-2 py-1 bg-background">
            <option value="zscore">Z-score + ADX</option>
            <option value="ict_hmm">ICT / HMM 5-cluster</option>
          </select>
          <label className="dry-run-toggle"><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} data-testid="input-dry-run" /><span className="toggle-track" /><span>Preview only</span></label><button className="button button-primary" onClick={runScan} disabled={runStrategy.isPending || dashboardQuery.isLoading} data-testid="button-run-scan">{runStrategy.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} Run scan</button></div>}
      />
      {notice && <div className="notice-banner" data-testid="status-action-notice"><Info size={14} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice" data-testid="button-dismiss-notice"><X size={14} /></button></div>}
      {dashboardQuery.isLoading ? <LoadingPanel rows={6} /> : dashboardQuery.isError || !dashboard ? <ErrorPanel onRetry={() => dashboardQuery.refetch()} /> : (
        <div className="space-y-5">
          <AccountStrip account={dashboard.account} />
          <MetricRail metrics={dashboard.metrics} />
          <div className="dashboard-grid">
            <AgentStatusCard
              status={dashboard.status}
              onFlatten={flattenPositions}
              flattenPending={flatten.isPending}
              onStart={startContinuousAgent}
              onStop={stopContinuousAgent}
              startPending={startAgent.isPending}
              stopPending={stopAgent.isPending}
              intervalSeconds={intervalSeconds}
              onIntervalChange={setIntervalSeconds}
            />
            <div className="panel activity-panel">
              <CardHeader eyebrow="03 / event stream" title="Recent decisions" action={<Link href="/audit" className="text-link" data-testid="link-view-all-activity">View audit <ChevronRight size={13} /></Link>} />
              <ActivityList activity={dashboard.activity} compact />
            </div>
          </div>
          <SnapshotTable snapshots={snapshots} onSelect={setSelectedSymbol} />
          {selectedSymbol && <SymbolDetail symbol={selectedSymbol} onClose={() => setSelectedSymbol('')} />}
        </div>
      )}
    </>
  );
}

function GuardrailRow({ label, detail, enabled, value }: { label: string; detail: string; enabled: boolean; value?: string }) {
  return <div className="guardrail-row"><div className={cx('guardrail-check', enabled ? 'is-on' : 'is-off')}>{enabled ? <Check size={12} /> : <X size={12} />}</div><div className="min-w-0 flex-1"><div className="text-xs font-bold">{label}</div><div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{detail}</div></div>{value && <div className="guardrail-value">{value}</div>}</div>;
}

function StrategyPage() {
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 } });
  const status = statusQuery.data;
  return (
    <>
      <PageIntro eyebrow="Strategy / explainability" title="The logic is the product." description="A mean-reversion playbook with explicit gates. Nothing enters the order lane without passing the trace." action={<Link href="/dashboard" className="button button-secondary" data-testid="link-back-control-room"><LayoutDashboard size={14} /> Control room</Link>} />
      {statusQuery.isLoading ? <LoadingPanel rows={7} /> : statusQuery.isError || !status ? <ErrorPanel onRetry={() => statusQuery.refetch()} /> : <StrategyContent guardrails={status.guardrails} symbols={status.symbols} />}
    </>
  );
}

function StrategyContent({ guardrails, symbols }: { guardrails: GuardrailState; symbols: string[] }) {
  const queryClient = useQueryClient();
  const run = useRunStrategy();
  const [selectedSymbols, setSelectedSymbols] = useState(symbols);
  const [entryZ, setEntryZ] = useState(String(guardrails.entryZ));
  const [adxMax, setAdxMax] = useState(String(guardrails.adxMax));
  const [minVolumeRatio, setMinVolumeRatio] = useState(String(guardrails.minVolumeRatio));
  const [notice, setNotice] = useState('');
  const submitScan = () => {
    if (!selectedSymbols.length) {
      setNotice('Select at least one tradable asset before scanning.');
      return;
    }
    const settings = { entryZ: Number(entryZ), adxMax: Number(adxMax), minVolumeRatio: Number(minVolumeRatio) };
    if (Object.values(settings).some((value) => !Number.isFinite(value) || value <= 0)) {
      setNotice('Strategy thresholds must be positive numbers.');
      return;
    }
    setNotice('');
    run.mutate({ data: { symbols: selectedSymbols, dryRun: true, settings } }, {
      onSuccess: (result) => {
        setNotice(`Paper scan complete · ${result.evaluated} assets evaluated · ${result.actions.length} actions`);
        queryClient.invalidateQueries({ queryKey: getGetAgentDashboardQueryKey() });
      },
      onError: () => setNotice('The paper scan could not be completed. Check the Alpaca connection and retry.'),
    });
  };
  const gates = [
    { label: 'Volume confirmation', detail: 'Current volume must clear the recent average before a signal can advance.', enabled: guardrails.volumeFilter, value: `${guardrails.minVolumeRatio.toFixed(2)}x min` },
    { label: 'Trend strength gate', detail: 'Avoid entries when directional pressure says mean reversion is fighting the tape.', enabled: guardrails.adxFilter, value: `ADX < ${guardrails.adxMax.toFixed(0)}` },
    { label: 'Hard invalidation', detail: 'A move beyond the invalidation band exits the thesis immediately.', enabled: guardrails.hardInvalidation, value: `Z ${guardrails.invalidationZ.toFixed(1)}` },
    { label: 'Trailing stop', detail: 'Profits are protected as a position moves back toward its mean.', enabled: guardrails.trailingStop },
    { label: 'Duplicate position check', detail: 'One thesis, one position. Existing exposure blocks a duplicate entry.', enabled: guardrails.duplicatePositionCheck },
    { label: 'Paper-only execution', detail: 'The execution adapter cannot route a live order from this cockpit.', enabled: guardrails.paperOnly, value: 'LOCKED' },
  ];
  return (
    <div className="space-y-5">
      <div className="logic-layout">
        <div className="panel logic-diagram">
          <CardHeader eyebrow="01 / decision path" title="From scan to order" action={<span className="font-mono text-[10px] text-primary">6 gates</span>} />
          <div className="flow-diagram">
            <div className="flow-node is-start"><Search size={15} /><div><strong>Scan</strong><small>price + volume</small></div></div>
            <div className="flow-line" />
            <div className="flow-node"><BarChart3 size={15} /><div><strong>Normalize</strong><small>SMA / σ band</small></div></div>
            <div className="flow-line" />
            <div className="flow-node is-accent"><Crosshair size={15} /><div><strong>Classify</strong><small>entry / exit / hold</small></div></div>
            <div className="flow-line" />
            <div className="flow-node is-end"><ShieldCheck size={15} /><div><strong>Guard</strong><small>paper order or block</small></div></div>
          </div>
          <div className="formula-box"><span className="font-mono text-[10px] text-muted-foreground">Z-SCORE</span><span className="formula">z = (price − SMA) / stddev</span><span className="font-mono text-[10px] text-primary">MEAN REVERSION</span></div>
        </div>
        <div className="panel threshold-card">
          <CardHeader eyebrow="02 / thresholds" title="Signal bands" />
          <div className="threshold-visual"><div className="threshold-line"><span className="threshold-label top">short entry</span><span className="threshold-value top">{guardrails.entryZ.toFixed(1)}σ</span><i style={{ top: '17%' }} /><span className="threshold-label exit">mean / exit</span><span className="threshold-value exit">0.0σ</span><i style={{ top: '50%' }} /><span className="threshold-label bottom">long entry</span><span className="threshold-value bottom">{guardrails.entryZ.toFixed(1)}σ</span><i style={{ top: '83%' }} /></div></div>
          <div className="threshold-note"><Info size={14} /><span>Entry is symmetric. Exit is patient. Invalidation is not.</span></div>
        </div>
      </div>
      <div className="panel">
        <CardHeader eyebrow="03 / active guardrails" title="Why the agent can say no" action={<span className="font-mono text-[10px] text-muted-foreground">{symbols.length} symbols in scope</span>} />
        <div className="guardrail-list">{gates.map((gate) => <GuardrailRow key={gate.label} {...gate} />)}</div>
      </div>
      <div className="panel operator-panel">
        <CardHeader eyebrow="04 / operator controls" title="Choose the paper scan" action={<span className="status-chip is-good"><span /> paper-only</span>} />
        <div className="operator-panel-body">
          <div>
            <div className="field-label">Assets</div>
            <AssetPicker selected={selectedSymbols} onChange={setSelectedSymbols} />
          </div>
          <div className="strategy-tuner">
            <div className="field-label">Tune strategy thresholds</div>
            <div className="settings-field-grid">
              <label><span className="field-label">Entry Z</span><input type="number" min="0.1" step="0.05" value={entryZ} onChange={(event) => setEntryZ(event.target.value)} data-testid="input-strategy-entry-z" /></label>
              <label><span className="field-label">ADX max</span><input type="number" min="1" step="1" value={adxMax} onChange={(event) => setAdxMax(event.target.value)} data-testid="input-strategy-adx-max" /></label>
              <label><span className="field-label">Volume floor</span><input type="number" min="0.1" step="0.05" value={minVolumeRatio} onChange={(event) => setMinVolumeRatio(event.target.value)} data-testid="input-strategy-volume-ratio" /></label>
            </div>
            <button className="button button-primary mt-4" onClick={submitScan} disabled={run.isPending} data-testid="button-run-configured-scan">{run.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} {run.isPending ? 'Scanning…' : 'Run paper scan'}</button>
          </div>
        </div>
        {notice && <div className="notice-banner m-5 mt-0"><Info size={14} /><span>{notice}</span></div>}
      </div>
      <div className="explain-grid">
        <div className="panel explanation-panel"><div className="explanation-number">A</div><div><div className="eyebrow">When it enters</div><h3>Extreme distance, quiet trend.</h3><p>Price must be sufficiently far from its moving mean while ADX and volume confirm the setup is not simply momentum in disguise.</p></div></div>
        <div className="panel explanation-panel"><div className="explanation-number">B</div><div><div className="eyebrow">When it blocks</div><h3>One failed gate is enough.</h3><p>Blocked decisions stay visible in the audit trail with the exact reason. A missing trade is an explained outcome, not a mystery.</p></div></div>
      </div>
    </div>
  );
}

function BacktestResultPanel({ result }: { result: BacktestResult }) {
  const metrics = [
    { label: 'Final equity', value: money(result.finalEquity) },
    { label: 'Net P&L', value: money(result.netPnl), tone: result.netPnl >= 0 ? 'text-primary' : 'text-destructive' },
    { label: 'Strategy return', value: pct(result.returnPct), tone: result.returnPct >= 0 ? 'text-primary' : 'text-destructive' },
    { label: 'Max drawdown', value: pct(-result.maxDrawdownPct), tone: 'text-destructive' },
  ];
  return (
    <div className="space-y-5" data-testid="panel-backtest-result">
      <div className="account-strip">
        {metrics.map((metric) => (
          <div className="account-cell" key={metric.label}>
            <div className="eyebrow">{metric.label}</div>
            <div className={cx('account-value', metric.tone)}>{metric.value}</div>
          </div>
        ))}
      </div>
      <div className="panel">
        <CardHeader eyebrow="02 / result summary" title="Historical run complete" action={<span className="status-chip is-good"><span /> Alpaca · {result.timeframe}</span>} />
        <div className="detail-stat-grid">
          <div><span>Bars loaded</span><strong>{result.barsLoaded}</strong></div>
          <div><span>Trades</span><strong>{result.totalTrades}</strong></div>
          <div><span>Win rate</span><strong>{result.winRate.toFixed(1)}%</strong></div>
          <div><span>Buy & hold</span><strong>{pct(result.benchmarkReturnPct)}</strong></div>
          <div><span>Range</span><strong>{result.start} → {result.end}</strong></div>
          <div><span>Symbols</span><strong>{result.symbols.join(', ')}</strong></div>
        </div>
      </div>
      <div className="panel overflow-hidden">
        <CardHeader eyebrow="03 / execution ledger" title="Simulated trades" action={<span className="font-mono text-[10px] text-muted-foreground">{result.winningTrades} wins · {result.losingTrades} losses</span>} />
        {result.trades.length === 0 ? <EmptyState title="No trades in this range" description="The guardrails did not produce a completed entry and exit for the selected data." /> : (
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Exit</th><th>Qty</th><th>P&L</th><th>Reason</th></tr></thead>
              <tbody>
                {result.trades.map((trade, index) => (
                  <tr key={`${trade.symbol}-${trade.entryAt}-${index}`}>
                    <td><strong>{trade.symbol}</strong></td>
                    <td className="text-xs uppercase">{trade.side}</td>
                    <td className="font-mono text-xs">${trade.entryPrice.toFixed(2)}<small>{trade.entryAt}</small></td>
                    <td className="font-mono text-xs">${trade.exitPrice.toFixed(2)}<small>{trade.exitAt}</small></td>
                    <td className="font-mono text-xs">{trade.quantity}</td>
                    <td className={cx('font-mono text-xs', trade.pnl >= 0 ? 'text-primary' : 'text-destructive')}>{money(trade.pnl)}<small>{pct(trade.returnPct)}</small></td>
                    <td className="text-xs text-muted-foreground">{trade.exitReason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function OptimizationPanel({ result }: { result: OptimizationResult }) {
  const improved = result.best.returnPct - result.baseline.returnPct;
  return (
    <div className="space-y-5" data-testid="panel-optimization-result">
      <div className="panel">
        <CardHeader eyebrow="Optimization / selected candidate" title="Best risk-adjusted settings" action={<span className="status-chip is-good"><span /> {result.candidatesTested} candidates tested</span>} />
        <div className="optimization-summary">
          <div><span>Entry threshold</span><strong>{result.bestSettings.entryZ.toFixed(2)}σ</strong></div>
          <div><span>ADX ceiling</span><strong>{result.bestSettings.adxMax.toFixed(0)}</strong></div>
          <div><span>Volume floor</span><strong>{result.bestSettings.minVolumeRatio.toFixed(2)}x</strong></div>
          <div><span>Change vs baseline</span><strong className={improved >= 0 ? 'text-primary' : 'text-destructive'}>{pct(improved)}</strong></div>
        </div>
        <div className="optimization-note">Ranked by return minus half the maximum drawdown. These settings are a research result only; live guardrails were not changed.</div>
      </div>
      <div className="panel overflow-hidden">
        <CardHeader eyebrow="Optimization / leaderboard" title="Top candidates" action={<span className="font-mono text-[10px] text-muted-foreground">baseline {pct(result.baseline.returnPct)}</span>} />
        <div className="table-scroll">
          <table className="data-table">
            <thead><tr><th>#</th><th>Entry Z</th><th>ADX max</th><th>Volume</th><th>Score</th><th>Return</th><th>Drawdown</th><th>Trades</th></tr></thead>
            <tbody>
              {result.leaderboard.map((candidate, index) => (
                <tr key={`${candidate.settings.entryZ}-${candidate.settings.adxMax}-${candidate.settings.minVolumeRatio}`}>
                  <td className="font-mono text-xs">{index + 1}</td>
                  <td className="font-mono text-xs">{candidate.settings.entryZ.toFixed(2)}σ</td>
                  <td className="font-mono text-xs">{candidate.settings.adxMax.toFixed(0)}</td>
                  <td className="font-mono text-xs">{candidate.settings.minVolumeRatio.toFixed(2)}x</td>
                  <td className="font-mono text-xs">{pct(candidate.score)}</td>
                  <td className={cx('font-mono text-xs', candidate.returnPct >= 0 ? 'text-primary' : 'text-destructive')}>{pct(candidate.returnPct)}</td>
                  <td className="font-mono text-xs text-destructive">{pct(-candidate.maxDrawdownPct)}</td>
                  <td className="font-mono text-xs">{candidate.totalTrades}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BacktestPage() {
  const today = dateInputValue(new Date());
  const defaultStart = dateInputValue(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
  const run = useRunBacktest();
  const optimize = useOptimizeBacktest();
  const [symbols, setSymbols] = useState('SPY, QQQ, IWM, AAPL');
  const [start, setStart] = useState(defaultStart);
  const [end, setEnd] = useState(today);
  const [initialCapital, setInitialCapital] = useState('100000');
  const [timeframe, setTimeframe] = useState<BacktestInputTimeframe>('1Day');
  const [feed, setFeed] = useState<BacktestInputFeed>('iex');
  const [entryZ, setEntryZ] = useState('2');
  const [adxMax, setAdxMax] = useState('25');
  const [minVolumeRatio, setMinVolumeRatio] = useState('1');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [optimization, setOptimization] = useState<OptimizationResult | null>(null);
  const [notice, setNotice] = useState('');

  const getInput = () => {
    const selectedSymbols = symbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean);
    const capital = Number(initialCapital);
    if (!selectedSymbols.length || !start || !end || !Number.isFinite(capital) || capital <= 0) {
      setNotice('Enter at least one symbol, a valid date range, and starting capital above zero.');
      return null;
    }
    if (start >= end) {
      setNotice('The start date must be before the end date.');
      return null;
    }
    return {
      symbols: selectedSymbols,
      start,
      end,
      initialCapital: capital,
      timeframe,
      feed,
    };
  };

  const submit = () => {
    const input = getInput();
    if (!input) return;
    setNotice('');
    setResult(null);
    run.mutate({ data: { ...input, settings: { entryZ: Number(entryZ), adxMax: Number(adxMax), minVolumeRatio: Number(minVolumeRatio) } } }, {
      onSuccess: (backtest) => setResult(backtest),
      onError: () => setNotice('The Alpaca backtest could not be completed. Check the date range and API connection, then retry.'),
    });
  };

  const submitOptimization = () => {
    const input = getInput();
    if (!input) return;
    setNotice('');
    setOptimization(null);
    optimize.mutate({ data: input }, {
      onSuccess: (optimized) => setOptimization(optimized),
      onError: () => setNotice('The strategy optimization could not be completed. Check the date range and API connection, then retry.'),
    });
  };

  return (
    <>
      <PageIntro eyebrow="Research / historical replay" title="Test the decision path." description="Choose the Alpaca universe, market-data feed, timeframe, and strategy thresholds. This is a read-only simulation: no orders are submitted." action={<Link href="/dashboard" className="button button-secondary" data-testid="link-back-control-room"><LayoutDashboard size={14} /> Control room</Link>} />
      <div className="panel backtest-form" data-testid="panel-backtest-form">
        <CardHeader eyebrow="01 / test parameters" title="Choose a replay window" action={<div className="mode-pill is-paper"><span className="mode-pill-dot" /> Alpaca {feed.toUpperCase()} data</div>} />
        <div className="backtest-fields">
          <label className="backtest-symbols-field"><span>Symbols</span><input value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="SPY, QQQ, AAPL" data-testid="input-backtest-symbols" /><small>Comma-separated · maximum 8</small><AssetPicker selected={symbols.split(',').map((symbol) => symbol.trim().toUpperCase()).filter(Boolean)} onChange={(next) => setSymbols(next.join(', '))} /></label>
          <label><span>Initial capital</span><input type="number" min="1" step="1000" value={initialCapital} onChange={(event) => setInitialCapital(event.target.value)} data-testid="input-backtest-capital" /><small>Each symbol receives an equal allocation</small></label>
          <label><span>Start date</span><input type="date" value={start} max={end} onChange={(event) => setStart(event.target.value)} data-testid="input-backtest-start" /></label>
          <label><span>End date</span><input type="date" value={end} min={start} onChange={(event) => setEnd(event.target.value)} data-testid="input-backtest-end" /></label>
          <label><span>Timeframe</span><select value={timeframe} onChange={(event) => setTimeframe(event.target.value as BacktestInputTimeframe)} data-testid="select-backtest-timeframe"><option value="1Min">1 minute</option><option value="5Min">5 minutes</option><option value="15Min">15 minutes</option><option value="1Hour">1 hour</option><option value="1Day">1 day</option></select><small>Intraday ranges may be limited by data availability</small></label>
          <label><span>Market-data feed</span><select value={feed} onChange={(event) => setFeed(event.target.value as BacktestInputFeed)} data-testid="select-backtest-feed"><option value="iex">IEX · included</option><option value="sip">SIP · entitlement required</option><option value="delayed_sip">Delayed SIP</option></select><small>Alpaca account permissions apply</small></label>
          <label><span>Entry Z threshold</span><input type="number" min="0.1" step="0.05" value={entryZ} onChange={(event) => setEntryZ(event.target.value)} data-testid="input-backtest-entry-z" /><small>Distance from the moving mean</small></label>
          <label><span>ADX maximum</span><input type="number" min="1" step="1" value={adxMax} onChange={(event) => setAdxMax(event.target.value)} data-testid="input-backtest-adx-max" /><small>Reject stronger trends</small></label>
          <label><span>Minimum volume ratio</span><input type="number" min="0.1" step="0.05" value={minVolumeRatio} onChange={(event) => setMinVolumeRatio(event.target.value)} data-testid="input-backtest-volume-ratio" /><small>Compared with the recent average</small></label>
        </div>
        <div className="status-footer backtest-form-footer">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><LockKeyhole size={13} /> Simulation only · no order endpoint is used</div>
          <div className="flex gap-2">
            <button className="button button-secondary" onClick={submitOptimization} disabled={run.isPending || optimize.isPending} data-testid="button-optimize-backtest">{optimize.isPending ? <RefreshCw size={14} className="animate-spin" /> : <TrendingUp size={14} />} {optimize.isPending ? 'Testing…' : 'Optimize'}</button>
            <button className="button button-primary" onClick={submit} disabled={run.isPending || optimize.isPending} data-testid="button-run-backtest">{run.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} {run.isPending ? 'Loading bars…' : 'Run backtest'}</button>
          </div>
        </div>
      </div>
      {notice && <div className="notice-banner" data-testid="status-backtest-notice"><AlertTriangle size={14} /><span>{notice}</span></div>}
      {optimization && <OptimizationPanel result={optimization} />}
      {result && <BacktestResultPanel result={result} />}
    </>
  );
}

function ActivityPage() {
  const dashboardQuery = useGetAgentDashboard({ query: { queryKey: getGetAgentDashboardQueryKey(), refetchInterval: 30000 } });
  const [filter, setFilter] = useState('all');
  const activity = useMemo(() => {
    const items = dashboardQuery.data?.activity ?? [];
    return filter === 'all' ? items : items.filter((item) => item.status === filter);
  }, [dashboardQuery.data?.activity, filter]);
  return (
    <>
      <PageIntro eyebrow="Audit / activity log" title="Nothing happens off-book." description="A chronological record of scans, decisions, blocks, and simulated or submitted paper orders." action={<button className="button button-secondary" onClick={() => dashboardQuery.refetch()} disabled={dashboardQuery.isFetching} data-testid="button-refresh-activity"><RefreshCw size={14} className={dashboardQuery.isFetching ? 'animate-spin' : ''} /> Refresh</button>} />
      {dashboardQuery.isLoading ? <LoadingPanel rows={8} /> : dashboardQuery.isError ? <ErrorPanel onRetry={() => dashboardQuery.refetch()} /> : (
        <div className="panel activity-page-panel">
          <CardHeader eyebrow="Event stream" title="Decision ledger" action={<div className="filter-tabs">{['all', 'submitted', 'simulated', 'blocked', 'closed'].map((item) => <button className={cx(filter === item && 'is-active')} onClick={() => setFilter(item)} key={item} data-testid={`button-filter-${item}`}>{item}</button>)}</div>} />
          {activity.length ? <ActivityList activity={activity} /> : <EmptyState title="No events match this filter" description="Try another status or return after the next scan." />}
        </div>
      )}
    </>
  );
}

function AccountPage() {
  const accountQuery = useGetAgentAccount({ query: { queryKey: getGetAgentAccountQueryKey(), refetchInterval: 30000 } });
  const overview = accountQuery.data;
  return (
    <>
      <PageIntro eyebrow="Account / paper ledger" title="Know what Alpaca knows." description="Inspect the paper account, open positions, and recent orders directly from the Alpaca account adapter." action={<button className="button button-secondary" onClick={() => accountQuery.refetch()} disabled={accountQuery.isFetching} data-testid="button-refresh-account"><RefreshCw size={14} className={accountQuery.isFetching ? 'animate-spin' : ''} /> Refresh</button>} />
      {accountQuery.isLoading ? <LoadingPanel rows={7} /> : accountQuery.isError || !overview ? <ErrorPanel onRetry={() => accountQuery.refetch()} /> : (
        <div className="space-y-5">
          <AccountStrip account={overview.account} />
          <div className="account-ledger-grid">
            <div className="panel overflow-hidden">
              <CardHeader eyebrow="01 / open exposure" title="Positions" action={<span className="font-mono text-[10px] text-muted-foreground">{overview.positions.length} open</span>} />
              {overview.positions.length === 0 ? <EmptyState title="No open positions" description="Paper positions opened through Alpaca will appear here." /> : (
                <div className="table-scroll"><table className="data-table"><thead><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Mark</th><th>Market value</th><th>Unrealized</th></tr></thead><tbody>
                  {overview.positions.map((position) => <tr key={position.symbol}><td><strong>{position.symbol}</strong></td><td className="text-xs uppercase">{position.side}</td><td className="font-mono text-xs">{position.qty}</td><td className="font-mono text-xs">{money(position.avgEntryPrice)}</td><td className="font-mono text-xs">{money(position.currentPrice)}</td><td className="font-mono text-xs">{money(position.marketValue)}</td><td className={cx('font-mono text-xs', position.unrealizedPnl >= 0 ? 'text-primary' : 'text-destructive')}>{money(position.unrealizedPnl)}</td></tr>)}
                </tbody></table></div>
              )}
            </div>
            <div className="panel overflow-hidden">
              <CardHeader eyebrow="02 / order history" title="Recent orders" action={<span className="font-mono text-[10px] text-muted-foreground">{overview.orders.length} returned</span>} />
              {overview.orders.length === 0 ? <EmptyState title="No orders returned" description="Paper orders submitted through the agent will be listed here." /> : (
                <div className="table-scroll"><table className="data-table"><thead><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Status</th><th>Qty</th><th>Submitted</th></tr></thead><tbody>
                  {overview.orders.map((order) => <tr key={order.id}><td><strong>{order.symbol}</strong></td><td className="text-xs uppercase">{order.side}</td><td className="text-xs uppercase">{order.type}</td><td><span className="trade-state is-clear">{order.status}</span></td><td className="font-mono text-xs">{order.filledQty} / {order.qty}</td><td className="font-mono text-xs">{formatDateTime(order.submittedAt)}</td></tr>)}
                </tbody></table></div>
              )}
            </div>
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">Last account sync · {formatDateTime(overview.fetchedAt)} · paper adapter only</div>
        </div>
      )}
    </>
  );
}

function SettingsPage() {
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 } });
  const [polling, setPolling] = useState(true);
  const [confirmSafety, setConfirmSafety] = useState(true);
  const status = statusQuery.data;
  return (
    <>
      <PageIntro eyebrow="Settings / execution safety" title="Keep the rails visible." description="Connection status is read-only here. Execution controls stay conservative by default." action={<div className="mode-pill is-paper"><span className="mode-pill-dot" /> Safety-first defaults</div>} />
      {statusQuery.isLoading ? <LoadingPanel rows={5} /> : statusQuery.isError || !status ? <ErrorPanel onRetry={() => statusQuery.refetch()} /> : (
        <div className="settings-layout">
          <div className="space-y-5">
            <div className="panel">
              <CardHeader eyebrow="01 / account connection" title="Broker adapter" action={<div className={cx('status-chip', status.connected ? 'is-good' : 'is-warn')}><span />{status.connected ? 'Healthy' : 'Needs attention'}</div>} />
              <div className="connection-card"><div className="connection-logo">A</div><div className="min-w-0 flex-1"><div className="font-display text-sm font-bold">Alpaca Markets</div><div className="mt-1 text-xs text-muted-foreground">API adapter · {status.mode === 'demo' ? 'local simulation' : 'paper-api.alpaca.markets'}</div></div><div className="connection-state"><span className="heartbeat-dot is-live" /> {status.mode === 'demo' ? 'Demo' : 'Paper'}</div></div>
              <div className="settings-field-grid"><div><span className="field-label">Environment</span><div className="field-value"><Database size={14} /> {status.mode === 'demo' ? 'Demo sandbox' : 'Paper trading'}</div></div><div><span className="field-label">Heartbeat</span><div className="field-value font-mono text-xs"><Activity size={14} /> {status.heartbeat}</div></div></div>
            </div>
            <div className="panel">
              <CardHeader eyebrow="02 / execution safeguards" title="Hard stops" action={<LockKeyhole size={16} className="text-primary" />} />
              <div className="settings-list">
                <label className="setting-row"><div><strong>Paper-only execution</strong><span>Live order routing is disabled at the adapter level.</span></div><input type="checkbox" checked disabled data-testid="input-paper-only" /><span className="switch is-locked"><i /></span></label>
                <label className="setting-row"><div><strong>Require guardrail pass</strong><span>Every order must clear all enabled gates.</span></div><input type="checkbox" checked={confirmSafety} onChange={(event) => setConfirmSafety(event.target.checked)} data-testid="input-require-guardrails" /><span className={cx('switch', confirmSafety && 'is-on')}><i /></span></label>
                <label className="setting-row"><div><strong>Automatic scan cadence</strong><span>Keep the agent heartbeat and next-run schedule active.</span></div><input type="checkbox" checked={polling} onChange={(event) => setPolling(event.target.checked)} data-testid="input-scan-cadence" /><span className={cx('switch', polling && 'is-on')}><i /></span></label>
              </div>
            </div>
          </div>
          <div className="panel settings-note-panel"><div className="eyebrow">Read this first</div><div className="mt-5 note-quote">“If a judge cannot follow the decision, the strategy has not finished explaining itself.”</div><div className="mt-5 space-y-4 text-xs leading-relaxed text-muted-foreground"><p>This surface intentionally exposes connection and safety state without pretending to configure secrets in the browser.</p><p>Use the API server environment to change credentials or switch the adapter. The UI will reflect the next heartbeat.</p></div><div className="mt-8 border-t border-border pt-4"><div className="flex items-center gap-2 text-xs font-semibold"><LifeBuoy size={14} className="text-primary" /> Operator checklist</div><ul className="checklist"><li><Check size={13} /> Paper account selected</li><li><Check size={13} /> Flatten control available</li><li><Check size={13} /> Activity trail recording</li></ul></div></div>
        </div>
      )}
    </>
  );
}

// ─── ANIMATION VARIANTS ──────────────────────────────────────────────────────
const fadeUp = {
  hidden: { opacity: 0, y: 28 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: 'easeOut' as const } },
};
const stagger = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09 } },
};
const fadeIn = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.5 } },
};

// ─── LANDING PAGE ─────────────────────────────────────────────────────────────

const TICKER_SYMBOLS = ['SPY +0.84%', 'QQQ +1.12%', 'AAPL +0.63%', 'NVDA +2.41%', 'TSLA -0.38%', 'IWM +0.55%', 'MSFT +0.91%', 'AMZN +1.07%'];

function TickerBar() {
  const doubled = [...TICKER_SYMBOLS, ...TICKER_SYMBOLS];
  return (
    <div className="ticker-bar" aria-hidden="true">
      <motion.div
        className="ticker-track"
        animate={{ x: ['0%', '-50%'] }}
        transition={{ duration: 22, repeat: Infinity, ease: 'linear' }}
      >
        {doubled.map((item, i) => (
          <span key={i} className={cx('ticker-item', item.includes('-') ? 'is-down' : 'is-up')}>
            {item}
          </span>
        ))}
      </motion.div>
    </div>
  );
}

function LandingNav() {
  return (
    <nav className="landing-nav">
      <div className="landing-nav-inner">
        <Link href="/" className="landing-logo">
          <div className="logo-mark" aria-hidden="true"><span /><span /><span /></div>
          <span>alpaca<strong>agent</strong></span>
        </Link>
        <div className="landing-nav-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
        </div>
        <Link href="/dashboard" className="button button-primary landing-cta-btn">
          Launch App <ArrowRight size={14} />
        </Link>
      </div>
    </nav>
  );
}

function HeroSection() {
  return (
    <section className="landing-hero">
      <TickerBar />
      <motion.div className="landing-hero-content" variants={stagger} initial="hidden" animate="show">
        <motion.div variants={fadeUp} className="landing-eyebrow">
          <span className="landing-badge"><Sparkles size={11} /> Paper trading · AI-powered · Fully explainable</span>
        </motion.div>
        <motion.h1 variants={fadeUp} className="landing-headline">
          The trading agent that<br />
          <span className="landing-headline-accent">shows its work.</span>
        </motion.h1>
        <motion.p variants={fadeUp} className="landing-subheadline">
          Alpaca Agent runs Z-score mean-reversion and ICT/SMC + HMM strategies on your paper account.
          Every decision is logged, every guardrail is visible, every order is explained.
        </motion.p>
        <motion.div variants={fadeUp} className="landing-hero-actions">
          <Link href="/dashboard" className="button button-primary landing-hero-btn">
            <Rocket size={15} /> Start for free
          </Link>
          <a href="#how-it-works" className="button button-secondary landing-hero-btn">
            See how it works
          </a>
        </motion.div>
        <motion.div variants={fadeUp} className="landing-hero-stats">
          {[['Paper only', 'Zero live risk'], ['2 strategy modes', 'Z-score + ICT/HMM'], ['6 guardrails', 'Every order gated'], ['Full audit trail', 'Nothing off-book']].map(([val, label]) => (
            <div key={val} className="landing-stat">
              <strong>{val}</strong>
              <span>{label}</span>
            </div>
          ))}
        </motion.div>
      </motion.div>
      <motion.div
        className="landing-hero-visual"
        initial={{ opacity: 0, scale: 0.94 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' as const }}
      >
        <div className="hero-terminal">
          <div className="hero-terminal-bar"><span /><span /><span /></div>
          <div className="hero-terminal-body">
            {[
              { t: 'SCAN', sym: 'SPY', z: '+2.14σ', sig: 'long_entry', cls: 'is-signal' },
              { t: 'BLOCK', sym: 'QQQ', z: '+1.87σ', sig: 'adx 28.4 > 25', cls: 'is-blocked' },
              { t: 'HOLD', sym: 'IWM', z: '+0.43σ', sig: 'hold', cls: 'is-hold' },
              { t: 'EXIT', sym: 'AAPL', z: '-0.12σ', sig: 'equilibrium', cls: 'is-exit' },
            ].map((row, i) => (
              <motion.div
                key={row.sym}
                className="hero-terminal-row"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.6 + i * 0.15, duration: 0.4 }}
              >
                <span className={cx('hero-sig', row.cls)}>{row.t}</span>
                <strong>{row.sym}</strong>
                <span className="hero-z">{row.z}</span>
                <span className="hero-reason">{row.sig}</span>
              </motion.div>
            ))}
          </div>
        </div>
      </motion.div>
    </section>
  );
}

const FEATURES = [
  { icon: Brain, title: 'Dual strategy engine', desc: 'Switch between Z-score mean-reversion + ADX and the full ICT/SMC + HMM 5-cluster engine per scan.' },
  { icon: Eye, title: 'Full explainability', desc: 'Every signal, block, and order carries a human-readable reason. Nothing enters the order lane silently.' },
  { icon: Shield, title: '6-layer guardrails', desc: 'Volume filter, ADX gate, hard invalidation, trailing stop, duplicate check, and paper-only lock.' },
  { icon: LineChart, title: 'Historical backtest', desc: 'Replay any date range against Alpaca market data. Optimize thresholds across 72 parameter combinations.' },
  { icon: Layers, title: 'Automation loop', desc: 'Set a scan cadence and let the agent run continuously. The in-flight guard prevents overlapping cycles.' },
  { icon: GitBranch, title: 'Audit trail', desc: 'Every scan decision is logged with timestamp, Z-score, action, and reason. Filter by status.' },
];

function FeaturesSection() {
  return (
    <section className="landing-section" id="features">
      <motion.div className="landing-section-header" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
        <motion.div variants={fadeUp} className="landing-eyebrow">What you get</motion.div>
        <motion.h2 variants={fadeUp} className="landing-section-title">Built for operators who want to understand every trade.</motion.h2>
      </motion.div>
      <motion.div className="features-grid" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
        {FEATURES.map(({ icon: Icon, title, desc }) => (
          <motion.div key={title} variants={fadeUp} className="feature-card">
            <div className="feature-icon"><Icon size={20} /></div>
            <h3>{title}</h3>
            <p>{desc}</p>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

const STEPS = [
  { n: '01', title: 'Connect Alpaca', desc: 'Add your Alpaca paper API key. No live trading credentials accepted. Demo mode works with zero setup.' },
  { n: '02', title: 'Choose your strategy', desc: 'Pick Z-score + ADX for mean-reversion or ICT/HMM 5-cluster for institutional structure analysis.' },
  { n: '03', title: 'Run a scan or automate', desc: 'One-shot scan or continuous loop. The agent evaluates every symbol, applies all guardrails, and logs the outcome.' },
  { n: '04', title: 'Read the audit trail', desc: 'Every decision is explained. See why the agent entered, blocked, or exited — with the exact indicator values.' },
];

function HowItWorksSection() {
  return (
    <section className="landing-section landing-section-alt" id="how-it-works">
      <motion.div className="landing-section-header" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
        <motion.div variants={fadeUp} className="landing-eyebrow">How it works</motion.div>
        <motion.h2 variants={fadeUp} className="landing-section-title">From API key to explained paper order in four steps.</motion.h2>
      </motion.div>
      <motion.div className="steps-grid" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
        {STEPS.map(({ n, title, desc }, i) => (
          <motion.div key={n} variants={fadeUp} className="step-card">
            <div className="step-number">{n}</div>
            <h3>{title}</h3>
            <p>{desc}</p>
            {i < STEPS.length - 1 && <div className="step-connector" />}
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

const OFFER_ITEMS = [
  {
    tag: 'Strategy A',
    title: 'Z-score Mean Reversion + ADX',
    desc: 'Classic statistical arbitrage. Price deviates from its 20-bar SMA, ADX confirms the regime is not trending, volume clears the floor. Entry is symmetric, exit is patient.',
    bullets: ['20-bar SMA / stddev band', 'ADX trend filter (default < 25)', 'Volume ratio floor', '2% trailing stop', 'Hard invalidation at 3.5σ'],
    accent: 'offer-card-a',
  },
  {
    tag: 'Strategy B',
    title: 'ICT / SMC + HMM 5-Cluster',
    desc: 'Institutional structure analysis. A 3-state HMM classifies the regime, ICT/SMC features detect FVGs, BoS, CHoCH, and liquidity sweeps. The 5-cluster router gates entries by AWD ≥ 0.65.',
    bullets: ['3-state HMM regime classifier', 'FVG, BoS, CHoCH, sweep detection', 'AWD = 0.45×HMM + 0.35×TMA + 0.20×vol', '5 clusters: A–E', 'Causal, closed-bar only'],
    accent: 'offer-card-b',
  },
];

function WhatWeOfferSection() {
  return (
    <section className="landing-section" id="offer">
      <motion.div className="landing-section-header" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
        <motion.div variants={fadeUp} className="landing-eyebrow">What we offer</motion.div>
        <motion.h2 variants={fadeUp} className="landing-section-title">Two strategy engines. One explainable cockpit.</motion.h2>
      </motion.div>
      <motion.div className="offer-grid" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
        {OFFER_ITEMS.map(({ tag, title, desc, bullets, accent }) => (
          <motion.div key={tag} variants={fadeUp} className={cx('offer-card', accent)}>
            <div className="offer-tag">{tag}</div>
            <h3>{title}</h3>
            <p>{desc}</p>
            <ul>
              {bullets.map((b) => (
                <li key={b}><CircleCheck size={13} />{b}</li>
              ))}
            </ul>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    period: 'forever',
    desc: 'Full access to the paper trading cockpit. No credit card required.',
    icon: Star,
    features: ['Z-score + ADX strategy', 'Demo mode (no API key needed)', 'Manual scan + one-shot run', 'Activity audit trail', '4 default symbols', 'Paper-only execution lock'],
    cta: 'Start free',
    href: '/dashboard',
    highlight: false,
  },
  {
    name: 'Pro',
    price: '$29',
    period: 'per month',
    desc: 'Both strategy engines, automation, backtest, and optimization.',
    icon: Zap,
    features: ['Everything in Free', 'ICT / HMM 5-cluster engine', 'Continuous automation loop', 'Historical backtest (180 days)', 'Strategy optimizer (72 candidates)', 'Up to 8 symbols', 'Priority support'],
    cta: 'Start Pro',
    href: '/dashboard',
    highlight: true,
  },
  {
    name: 'Institutional',
    price: 'Custom',
    period: 'contact us',
    desc: 'Multi-account, custom strategy integration, and dedicated support.',
    icon: Building2,
    features: ['Everything in Pro', 'Multi-account management', 'Custom strategy modules', 'Dedicated infrastructure', 'SLA + uptime guarantee', 'Onboarding & training', 'API access'],
    cta: 'Contact us',
    href: '/dashboard',
    highlight: false,
  },
];

function PricingSection() {
  return (
    <section className="landing-section landing-section-alt" id="pricing">
      <motion.div className="landing-section-header" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-80px' }}>
        <motion.div variants={fadeUp} className="landing-eyebrow">Pricing</motion.div>
        <motion.h2 variants={fadeUp} className="landing-section-title">Start free. Scale when you're ready.</motion.h2>
        <motion.p variants={fadeUp} className="landing-section-sub">All plans include paper-only execution. No live trading, no hidden fees.</motion.p>
      </motion.div>
      <motion.div className="pricing-grid" variants={stagger} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-60px' }}>
        {PLANS.map(({ name, price, period, desc, icon: Icon, features, cta, href, highlight }) => (
          <motion.div key={name} variants={fadeUp} className={cx('pricing-card', highlight && 'is-highlight')}>
            {highlight && <div className="pricing-badge"><Sparkles size={11} /> Most popular</div>}
            <div className="pricing-header">
              <div className="pricing-icon"><Icon size={18} /></div>
              <div>
                <div className="pricing-name">{name}</div>
                <div className="pricing-price">{price}<span>/{period}</span></div>
              </div>
            </div>
            <p className="pricing-desc">{desc}</p>
            <ul className="pricing-features">
              {features.map((f) => (
                <li key={f}><CircleCheck size={13} />{f}</li>
              ))}
            </ul>
            <Link href={href} className={cx('button pricing-btn', highlight ? 'button-primary' : 'button-secondary')}>
              {cta} <ArrowRight size={13} />
            </Link>
          </motion.div>
        ))}
      </motion.div>
    </section>
  );
}

function LandingFooter() {
  return (
    <footer className="landing-footer">
      <div className="landing-footer-inner">
        <div className="landing-footer-brand">
          <div className="logo-mark" aria-hidden="true"><span /><span /><span /></div>
          <span>alpaca<strong>agent</strong></span>
        </div>
        <div className="landing-footer-links">
          <a href="#features">Features</a>
          <a href="#how-it-works">How it works</a>
          <a href="#pricing">Pricing</a>
          <Link href="/dashboard">Launch app</Link>
        </div>
        <div className="landing-footer-note">Paper trading only · No live order routing · Built on Alpaca Markets API</div>
      </div>
    </footer>
  );
}

function LandingPage() {
  return (
    <div className="landing-root">
      <LandingNav />
      <HeroSection />
      <FeaturesSection />
      <HowItWorksSection />
      <WhatWeOfferSection />
      <PricingSection />
      <LandingFooter />
    </div>
  );
}

// ─── END LANDING PAGE ─────────────────────────────────────────────────────────

function NotFound() {
  return <div className="panel mx-auto mt-16 max-w-lg p-10 text-center"><div className="eyebrow">404 / off course</div><h1 className="mt-3 font-display text-3xl font-bold">This coordinate is not mapped.</h1><p className="mt-3 text-sm text-muted-foreground">Return to the control room to continue.</p><Link href="/dashboard" className="button button-primary mt-6" data-testid="link-not-found-home">Back to control room</Link></div>;
}

function Router() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={LandingPage} />
        <Route>
          <Shell>
            <Switch>
              <Route path="/dashboard" component={DashboardPage} />
              <Route path="/console" component={ConsolePage} />
              <Route path="/strategy" component={StrategyPage} />
              <Route path="/backtest" component={BacktestPage} />
              <Route path="/audit" component={AuditPage} />
              <Route path="/activity" component={ActivityPage} />
              <Route path="/risk" component={RiskPage} />
              <Route path="/architecture" component={ArchitecturePage} />
              <Route path="/settings" component={SettingsPage} />
              <Route path="/account" component={AccountPage} />
              <Route component={NotFound} />
            </Switch>
          </Shell>
        </Route>
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;