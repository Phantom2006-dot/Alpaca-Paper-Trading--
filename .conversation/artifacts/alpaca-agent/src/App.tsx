import { type ReactNode, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
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
  X,
  Zap,
} from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  getGetAgentDashboardQueryKey,
  getGetAgentStatusQueryKey,
  getGetMarketSnapshotQueryKey,
  useFlattenAgentPositions,
  useGetAgentDashboard,
  useGetAgentStatus,
  useGetMarketSnapshot,
  useHealthCheck,
  useRunStrategy,
} from '@workspace/api-client-react';
import type {
  AgentDashboard,
  AgentStatus,
  GuardrailState,
  StrategyActivity,
  SymbolSnapshot,
} from '@workspace/api-client-react';
import { Link, Route, Switch, Router as WouterRouter, useLocation } from 'wouter';

const queryClient = new QueryClient();

const navItems = [
  { href: '/', label: 'Control room', short: 'CTRL', icon: LayoutDashboard },
  { href: '/strategy', label: 'Strategy logic', short: 'LOGIC', icon: BrainCircuit },
  { href: '/activity', label: 'Activity log', short: 'AUDIT', icon: ListChecks },
  { href: '/settings', label: 'Settings', short: 'SETUP', icon: SlidersHorizontal },
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
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), refetchInterval: 30000 } });
  const healthQuery = useHealthCheck({ query: { queryKey: ['health-check'], refetchInterval: 30000 } });
  const status = statusQuery.data;
  const isDemo = status?.mode === 'demo';
  const isPaperHealthy = status?.mode === 'paper' && status.connected;
  const healthOk = healthQuery.data?.status === 'ok' || healthQuery.data?.status === 'healthy';

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <aside className={cx('app-sidebar', mobileNav && 'is-open')}>
        <div className="flex items-center justify-between px-5 py-5 lg:block lg:px-7 lg:py-7">
          <Link href="/" className="inline-flex" data-testid="link-sidebar-logo">
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
              <strong>{navItems.find((item) => item.href === location)?.short ?? 'CTRL'}</strong>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className={cx('mode-pill', isDemo ? 'is-demo' : 'is-paper')} data-testid="status-execution-mode">
              <span className="mode-pill-dot" />
              {statusQuery.isLoading ? 'SYNCING' : isDemo ? 'DEMO MODE' : isPaperHealthy ? 'PAPER CONNECTED' : 'PAPER NEEDS ATTENTION'}
            </div>
            <div className="topbar-divider" />
            <div className="hidden items-center gap-2 font-mono text-[10px] text-muted-foreground sm:flex">
              <Command size={13} />
              <span>R1.0.4</span>
            </div>
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

function AgentStatusCard({ status, onFlatten, flattenPending }: { status: AgentStatus; onFlatten: () => void; flattenPending: boolean }) {
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
        <div><span>Next scan</span><strong>{formatDateTime(status.nextRunAt)}</strong></div>
        <div><span>Heartbeat</span><strong className="font-mono text-[11px]">{status.heartbeat || '—'}</strong></div>
        <div><span>Guardrails</span><strong>{enabledGuardrails} / 6 live</strong></div>
      </div>
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
            <thead><tr><th>Symbol</th><th>Price</th><th>Z-score</th><th>ADX</th><th>Volume</th><th>Position</th><th>Signal</th><th>State</th></tr></thead>
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
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [notice, setNotice] = useState('');
  const dashboard = dashboardQuery.data;
  const snapshots = dashboard?.snapshots ?? fallbackSnapshots;
  const runScan = () => {
    if (!dashboard?.status.symbols?.length) {
      setNotice('No symbols are configured for this lane.');
      return;
    }
    setNotice('');
    runStrategy.mutate({ data: { symbols: dashboard.status.symbols, dryRun } }, {
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
  return (
    <>
      <PageIntro
        eyebrow="Live agent / control room"
        title="Good decisions leave a trail."
        description="See what the agent sees, why it waits, and where every paper order came from."
        action={<div className="flex items-center gap-2"><label className="dry-run-toggle"><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} data-testid="input-dry-run" /><span className="toggle-track" /><span>Preview only</span></label><button className="button button-primary" onClick={runScan} disabled={runStrategy.isPending || dashboardQuery.isLoading} data-testid="button-run-scan">{runStrategy.isPending ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />} Run scan</button></div>}
      />
      {notice && <div className="notice-banner" data-testid="status-action-notice"><Info size={14} /><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss notice" data-testid="button-dismiss-notice"><X size={14} /></button></div>}
      {dashboardQuery.isLoading ? <LoadingPanel rows={6} /> : dashboardQuery.isError || !dashboard ? <ErrorPanel onRetry={() => dashboardQuery.refetch()} /> : (
        <div className="space-y-5">
          <AccountStrip account={dashboard.account} />
          <MetricRail metrics={dashboard.metrics} />
          <div className="dashboard-grid">
            <AgentStatusCard status={dashboard.status} onFlatten={flattenPositions} flattenPending={flatten.isPending} />
            <div className="panel activity-panel">
              <CardHeader eyebrow="03 / event stream" title="Recent decisions" action={<Link href="/activity" className="text-link" data-testid="link-view-all-activity">View audit <ChevronRight size={13} /></Link>} />
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
      <PageIntro eyebrow="Strategy / explainability" title="The logic is the product." description="A mean-reversion playbook with explicit gates. Nothing enters the order lane without passing the trace." action={<Link href="/" className="button button-secondary" data-testid="link-back-control-room"><LayoutDashboard size={14} /> Control room</Link>} />
      {statusQuery.isLoading ? <LoadingPanel rows={7} /> : statusQuery.isError || !status ? <ErrorPanel onRetry={() => statusQuery.refetch()} /> : <StrategyContent guardrails={status.guardrails} symbols={status.symbols} />}
    </>
  );
}

function StrategyContent({ guardrails, symbols }: { guardrails: GuardrailState; symbols: string[] }) {
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
      <div className="explain-grid">
        <div className="panel explanation-panel"><div className="explanation-number">A</div><div><div className="eyebrow">When it enters</div><h3>Extreme distance, quiet trend.</h3><p>Price must be sufficiently far from its moving mean while ADX and volume confirm the setup is not simply momentum in disguise.</p></div></div>
        <div className="panel explanation-panel"><div className="explanation-number">B</div><div><div className="eyebrow">When it blocks</div><h3>One failed gate is enough.</h3><p>Blocked decisions stay visible in the audit trail with the exact reason. A missing trade is an explained outcome, not a mystery.</p></div></div>
      </div>
    </div>
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

function NotFound() {
  return <div className="panel mx-auto mt-16 max-w-lg p-10 text-center"><div className="eyebrow">404 / off course</div><h1 className="mt-3 font-display text-3xl font-bold">This coordinate is not mapped.</h1><p className="mt-3 text-sm text-muted-foreground">Return to the control room to continue.</p><Link href="/" className="button button-primary mt-6" data-testid="link-not-found-home">Back to control room</Link></div>;
}

function Router() {
  return <ErrorBoundary><Shell><Switch><Route path="/" component={DashboardPage} /><Route path="/strategy" component={StrategyPage} /><Route path="/activity" component={ActivityPage} /><Route path="/settings" component={SettingsPage} /><Route component={NotFound} /></Switch></Shell></ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><Router /></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;