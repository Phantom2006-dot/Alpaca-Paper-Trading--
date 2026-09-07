import { useState, useRef, useEffect } from 'react';
import { useAuth } from '@clerk/react';
import {
  useGetAgentAccount, useGetAgentStatus,
  getGetAgentAccountQueryKey, getGetAgentStatusQueryKey,
} from '@workspace/api-client-react';
import type { AgentStatus, AgentAccountOverview } from '@workspace/api-client-react';
import { Send, Bot, User, RefreshCw, TrendingUp, TrendingDown, ShoppingCart, AlertTriangle, Check } from 'lucide-react';

function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, '') ?? '';

type MsgRole = 'user' | 'agent' | 'system';
type OrderPreview = { symbol: string; side: 'buy' | 'sell'; qty: number; orderType: 'market' | 'limit'; limitPrice?: number };

interface Msg {
  id: string;
  role: MsgRole;
  text: string;
  ts: Date;
  orderPreview?: OrderPreview;
  orderResult?: { status: string; orderId: string | null; message: string };
  error?: boolean;
}

// ── Intent parser ─────────────────────────────────────────────────────────────
// Parses natural language into structured intents without an LLM dependency.

type Intent =
  | { type: 'buy'; symbol: string; qty: number; orderType: 'market' | 'limit'; limitPrice?: number }
  | { type: 'sell'; symbol: string; qty: number; orderType: 'market' | 'limit'; limitPrice?: number }
  | { type: 'portfolio' }
  | { type: 'status' }
  | { type: 'explain_strategy' }
  | { type: 'explain_demo' }
  | { type: 'explain_agent' }
  | { type: 'explain_zscore' }
  | { type: 'explain_ict' }
  | { type: 'explain_guardrails' }
  | { type: 'explain_scanning' }
  | { type: 'unknown' };

function parseIntent(text: string): Intent {
  const t = text.toLowerCase().trim();

  // Buy/sell: "buy 10 SPY", "sell 5 AAPL at 180", "buy SPY 3 shares market"
  const tradeRe = /^(buy|sell)\s+(\d+(?:\.\d+)?)\s+([a-z]{1,8})(?:\s+(?:at|@|limit)?\s*\$?(\d+(?:\.\d+)?))?/i;
  const tradeRe2 = /^(buy|sell)\s+([a-z]{1,8})\s+(\d+(?:\.\d+)?)(?:\s+(?:at|@|limit)?\s*\$?(\d+(?:\.\d+)?))?/i;
  let m = tradeRe.exec(t) ?? tradeRe2.exec(t);
  if (m) {
    const side = m[1].toLowerCase() as 'buy' | 'sell';
    const isRe1 = /^\d/.test(m[2]);
    const qty = parseFloat(isRe1 ? m[2] : m[3]);
    const symbol = (isRe1 ? m[3] : m[2]).toUpperCase();
    const limitPrice = m[4] ? parseFloat(m[4]) : undefined;
    return { type: side, symbol, qty: Math.max(1, Math.floor(qty)), orderType: limitPrice ? 'limit' : 'market', limitPrice };
  }

  if (/portfolio|positions?|holdings?|account|balance|equity|cash/.test(t)) return { type: 'portfolio' };
  if (/status|running|agent state|automation|scanning|next run|last run/.test(t)) return { type: 'status' };
  if (/demo mode|demo|simulation|no credentials|without key|without alpaca/.test(t)) return { type: 'explain_demo' };
  if (/how.*agent.*work|what.*agent do|agent.*trade|start agent|scanning.*work|what.*scanning/.test(t)) return { type: 'explain_agent' };
  if (/z.?score|mean.?reversion|sma|standard deviation/.test(t)) return { type: 'explain_zscore' };
  if (/ict|hmm|cluster|smart money|fvg|bos|choch|liquidity|displacement/.test(t)) return { type: 'explain_ict' };
  if (/guardrail|risk gate|adx|volume ratio|trailing stop|invalidation|position cap/.test(t)) return { type: 'explain_guardrails' };
  if (/strategy|how.*trade|what.*strategy|explain.*strategy/.test(t)) return { type: 'explain_strategy' };
  if (/scan|scanning|what.*scan/.test(t)) return { type: 'explain_scanning' };

  return { type: 'unknown' };
}

// ── Response generator ────────────────────────────────────────────────────────

function buildAgentReply(
  intent: Intent,
  status: AgentStatus | undefined,
  account: AgentAccountOverview | undefined,
): { text: string; orderPreview?: OrderPreview } {
  switch (intent.type) {
    case 'portfolio': {
      if (!account) return { text: 'I can\'t reach your account right now. Make sure your Alpaca credentials are saved in the Credentials page.' };
      const { equity, cash, buyingPower, dayPnl, dayPnlPct } = account.account;
      const pos = account.positions;
      const posText = pos.length
        ? pos.map((p) => `  • ${p.symbol} — ${p.qty} shares ${p.side}, entry $${p.avgEntryPrice.toFixed(2)}, mark $${p.currentPrice.toFixed(2)}, unrealized ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)}`).join('\n')
        : '  No open positions.';
      return {
        text: `**Your paper account:**\n\nEquity: $${equity.toLocaleString('en-US', { minimumFractionDigits: 2 })}\nCash: $${cash.toLocaleString('en-US', { minimumFractionDigits: 2 })}\nBuying power: $${buyingPower.toLocaleString('en-US', { minimumFractionDigits: 2 })}\nToday P&L: ${dayPnl >= 0 ? '+' : ''}$${dayPnl.toFixed(2)} (${dayPnlPct >= 0 ? '+' : ''}${dayPnlPct.toFixed(2)}%)\n\n**Open positions:**\n${posText}`,
      };
    }

    case 'status': {
      if (!status) return { text: 'Agent status is unavailable right now.' };
      const mode = status.mode === 'demo' ? '🟡 Demo mode (synthetic data)' : '🟢 Paper mode (live Alpaca data)';
      const running = status.running
        ? `Running — scans every ${status.intervalSeconds}s. Next run: ${status.nextRunAt ? new Date(status.nextRunAt).toLocaleTimeString() : '—'}`
        : 'Stopped — no automatic scans running.';
      const symbols = status.symbols?.join(', ') || 'none configured';
      const lastRun = status.lastRunAt ? new Date(status.lastRunAt).toLocaleTimeString() : 'never';
      return {
        text: `**Agent status:**\n\nMode: ${mode}\nAutomation: ${running}\nSymbols: ${symbols}\nLast scan: ${lastRun}${status.lastError ? `\n⚠️ Last error: ${status.lastError}` : ''}`,
      };
    }

    case 'explain_demo':
      return {
        text: `**Demo mode** runs when you haven't saved Alpaca credentials yet.\n\nInstead of real market data, the agent uses deterministic sine-wave price data generated from each symbol's ticker characters. This means:\n\n• All scans, signals, and guardrail decisions work exactly as in paper mode\n• Orders are simulated in memory — nothing touches Alpaca\n• Account shows $100,000 demo equity\n• Z-scores, ADX, and volume ratios are computed from the synthetic bars\n\nTo switch to paper mode, go to **Credentials** and enter your Alpaca paper API key and secret. The agent will verify them and start using real market data immediately.`,
      };

    case 'explain_agent':
      return {
        text: `**How the agent works:**\n\nWhen you click "Start agent" on the Dashboard, it begins a continuous loop:\n\n1. Every N seconds (you choose 1–30 min), it fetches the latest OHLCV bars for each symbol in your universe\n2. It computes Z-score, ADX, and volume ratio for each symbol\n3. It applies all 6 guardrails — if any fail, the trade is blocked\n4. If a signal passes all gates, it submits a paper market order to Alpaca\n5. Every decision (trade, block, hold) is logged to the Activity feed and Audit trail\n\nYou won't see a visual animation during automation — that's only on the **AI Console** page. The Dashboard's Activity feed and Symbol Scanner update every 30 seconds to show what the agent decided.\n\nTo see a live animated run, go to **AI Console** and click "Run Agent Cycle".`,
      };

    case 'explain_scanning':
      return {
        text: `**What "scanning" means:**\n\nEach scan cycle the agent:\n\n• Fetches 60 bars of price data for every symbol (SPY, QQQ, IWM, AAPL by default)\n• Computes a 20-bar SMA and standard deviation\n• Calculates Z-score = (price − SMA) / stddev\n• Checks ADX (trend strength) and volume ratio\n• Decides: long entry, short entry, exit, hold, or blocked\n\nIn **demo mode** this uses synthetic sine-wave data, so you'll see Z-scores move but they won't match real prices. In **paper mode** with your Alpaca key, it uses real IEX market data.\n\nThe scan result appears in the Dashboard's Symbol Scanner table and Activity feed. The Audit trail stores every decision with full JSON detail.`,
      };

    case 'explain_zscore':
      return {
        text: `**Z-score mean-reversion strategy:**\n\nZ = (price − 20-bar SMA) / standard deviation\n\n• Z ≤ −2.0σ → long entry signal (price is unusually low, expect reversion up)\n• Z ≥ +2.0σ → short entry signal (price is unusually high, expect reversion down)\n• Z crosses 0 → exit signal (price returned to mean)\n• |Z| ≥ 3.5σ → hard invalidation (extreme move, close immediately)\n\nAdditional gates: ADX must be < 25 (non-trending regime) and volume must be ≥ 1× the 20-bar average. A 2% trailing stop protects profits.`,
      };

    case 'explain_ict':
      return {
        text: `**ICT / HMM 5-cluster strategy:**\n\nThis mode layers two engines:\n\n**HMM regime classifier** — classifies the last 20 bars as Expansion, Retracement, or Consolidation using log-return statistics. Computes an AWD score (0–1). If AWD < 0.65, no trade.\n\n**ICT/SMC features** — detects:\n• Fair Value Gaps (FVG)\n• Break of Structure (BoS)\n• Change of Character (CHoCH)\n• Liquidity sweeps\n• Displacement candles\n\n**5-cluster router** maps the combination to one of:\n• A — Institutional Reversal (sweep + CHoCH)\n• B — Trend Expansion (BoS + displacement)\n• C — Value Retracement (FVG + killzone)\n• D — Correlation Basket (TMA extreme)\n• E — Range Liquidity (killzone + consolidation)\n\nSelect this mode from the strategy dropdown on Dashboard or Console.`,
      };

    case 'explain_guardrails':
      return {
        text: `**The 6 guardrails (risk gates):**\n\n1. **Entry Z-score ≥ 2.0σ** — price must be far enough from mean\n2. **ADX < 25** — blocks entries in trending regimes (mean-reversion doesn't work in trends)\n3. **Volume ratio ≥ 1.0×** — requires above-average volume to confirm the move\n4. **Duplicate position check** — one position per symbol, no stacking\n5. **Hard invalidation at 3.5σ** — closes position if price moves too far against the thesis\n6. **Paper-only lock** — hardcoded, cannot be disabled, no live order routing exists\n\nAll 6 must pass for an order to be submitted. Any single failure blocks the trade and logs the reason.`,
      };

    case 'explain_strategy':
      return {
        text: `Kairo has two strategy engines:\n\n**Z-score + ADX** (default) — statistical mean-reversion. Enters when price deviates ≥ 2σ from its 20-bar mean, exits at equilibrium. Requires non-trending regime (ADX < 25) and above-average volume.\n\n**ICT / HMM 5-cluster** — institutional structure analysis. Uses a Hidden Markov Model to classify market regime, then applies ICT/SMC concepts (FVG, BoS, CHoCH, liquidity sweeps) to route to one of 5 trade clusters.\n\nYou can switch between them on the Dashboard or Console page. Both work in demo mode and paper mode.`,
      };

    case 'buy':
    case 'sell': {
      const { symbol, qty, orderType, limitPrice } = intent;
      const preview: OrderPreview = { symbol, side: intent.type, qty, orderType, limitPrice };
      const priceStr = orderType === 'limit' && limitPrice ? ` at $${limitPrice.toFixed(2)} limit` : ' at market';
      return {
        text: `I'll place a paper **${intent.type.toUpperCase()}** order for **${qty} × ${symbol}**${priceStr}.\n\nThis is a paper order — no real money is involved. Confirm below to submit it to your Alpaca paper account.`,
        orderPreview: preview,
      };
    }

    default:
      return {
        text: `I can help you with:\n\n• **Portfolio** — "show my positions" or "what's my balance"\n• **Agent status** — "is the agent running" or "when's the next scan"\n• **Place orders** — "buy 5 SPY" or "sell 10 AAPL at 190"\n• **Explain strategies** — "how does Z-score work" or "explain ICT"\n• **Explain demo mode** — "what is demo mode"\n• **Explain guardrails** — "what are the risk gates"\n• **Explain scanning** — "what does scanning do"\n\nWhat would you like to know?`,
      };
  }
}

// ── Chat bubble ───────────────────────────────────────────────────────────────

function Bubble({ msg, onConfirmOrder, onCancelOrder, confirming }: {
  msg: Msg;
  onConfirmOrder?: (preview: OrderPreview) => void;
  onCancelOrder?: () => void;
  confirming?: boolean;
}) {
  const isAgent = msg.role === 'agent';
  const isSystem = msg.role === 'system';

  return (
    <div className={cx('chat-bubble-wrap', isAgent && 'is-agent', isSystem && 'is-system')}>
      {isAgent && (
        <div className="chat-avatar is-agent"><Bot size={14} /></div>
      )}
      <div className={cx('chat-bubble', isAgent && 'is-agent', isSystem && 'is-system', msg.error && 'is-error')}>
        <div className="chat-bubble-text">
          {msg.text.split('\n').map((line, i) => {
            // Bold **text**
            const parts = line.split(/\*\*(.+?)\*\*/g);
            return (
              <p key={i} className={line === '' ? 'chat-spacer' : ''}>
                {parts.map((part, j) => j % 2 === 1 ? <strong key={j}>{part}</strong> : part)}
              </p>
            );
          })}
        </div>

        {msg.orderPreview && !msg.orderResult && (
          <div className="chat-order-preview">
            <div className="chat-order-preview-row">
              <span className={cx('chat-order-side', msg.orderPreview.side === 'buy' ? 'is-buy' : 'is-sell')}>
                {msg.orderPreview.side === 'buy' ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                {msg.orderPreview.side.toUpperCase()}
              </span>
              <span className="font-mono font-bold">{msg.orderPreview.qty} × {msg.orderPreview.symbol}</span>
              <span className="text-xs text-muted-foreground">
                {msg.orderPreview.orderType === 'limit' ? `Limit $${msg.orderPreview.limitPrice?.toFixed(2)}` : 'Market'}
              </span>
            </div>
            <div className="chat-order-actions">
              <button
                className="button button-primary"
                style={{ fontSize: 11, padding: '4px 12px' }}
                onClick={() => onConfirmOrder?.(msg.orderPreview!)}
                disabled={confirming}
              >
                {confirming ? <RefreshCw size={11} className="animate-spin" /> : <ShoppingCart size={11} />}
                {confirming ? 'Submitting…' : 'Confirm paper order'}
              </button>
              <button
                className="button button-secondary"
                style={{ fontSize: 11, padding: '4px 10px' }}
                onClick={onCancelOrder}
                disabled={confirming}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {msg.orderResult && (
          <div className={cx('chat-order-result', msg.orderResult.status === 'submitted' || msg.orderResult.status === 'simulated' ? 'is-ok' : 'is-err')}>
            {msg.orderResult.status === 'submitted' || msg.orderResult.status === 'simulated'
              ? <><Check size={12} /> {msg.orderResult.message}</>
              : <><AlertTriangle size={12} /> {msg.orderResult.message}</>}
          </div>
        )}

        <div className="chat-bubble-ts">
          {msg.ts.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>
      {!isAgent && !isSystem && (
        <div className="chat-avatar is-user"><User size={14} /></div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const SUGGESTIONS = [
  'Show my portfolio',
  'Is the agent running?',
  'Buy 5 SPY',
  'How does Z-score work?',
  'What is demo mode?',
  'Explain the guardrails',
  'What does scanning do?',
];

export function ChatPage() {
  const { getToken } = useAuth();
  const accountQuery = useGetAgentAccount({ query: { queryKey: getGetAgentAccountQueryKey(), staleTime: 15000 } });
  const statusQuery = useGetAgentStatus({ query: { queryKey: getGetAgentStatusQueryKey(), staleTime: 15000 } });

  const [messages, setMessages] = useState<Msg[]>([{
    id: 'welcome',
    role: 'agent',
    ts: new Date(),
    text: `Hi! I'm Kairo, your paper trading agent.\n\nI can show your portfolio, explain how the strategies work, tell you what the agent is doing, and place paper orders for you.\n\nTry: "show my positions", "buy 10 SPY", or "how does Z-score work".`,
  }]);
  const [input, setInput] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null); // msg id being confirmed
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  function addMsg(msg: Omit<Msg, 'id'>) {
    const full: Msg = { ...msg, id: crypto.randomUUID() };
    setMessages((prev) => [...prev, full]);
    return full.id;
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput('');

    addMsg({ role: 'user', ts: new Date(), text: trimmed });

    const intent = parseIntent(trimmed);
    const { text: replyText, orderPreview } = buildAgentReply(intent, statusQuery.data, accountQuery.data);
    addMsg({ role: 'agent', ts: new Date(), text: replyText, orderPreview });
  }

  async function confirmOrder(msgId: string, preview: OrderPreview) {
    setConfirming(msgId);
    try {
      const token = await getToken();
      const res = await fetch(`${API}/api/agent/trade`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          symbol: preview.symbol,
          side: preview.side,
          qty: preview.qty,
          orderType: preview.orderType,
          limitPrice: preview.limitPrice ?? null,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Order failed');
      setMessages((prev) => prev.map((m) =>
        m.id === msgId ? { ...m, orderResult: { status: data.status, orderId: data.orderId, message: data.message } } : m,
      ));
      addMsg({ role: 'system', ts: new Date(), text: `✅ Paper order submitted: ${preview.side.toUpperCase()} ${preview.qty} × ${preview.symbol} — ${data.status === 'submitted' ? 'sent to Alpaca' : 'simulated in demo mode'}.` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Order failed';
      setMessages((prev) => prev.map((m) =>
        m.id === msgId ? { ...m, orderResult: { status: 'error', orderId: null, message: msg } } : m,
      ));
    } finally {
      setConfirming(null);
    }
  }

  function cancelOrder(msgId: string) {
    setMessages((prev) => prev.map((m) =>
      m.id === msgId ? { ...m, orderResult: { status: 'cancelled', orderId: null, message: 'Order cancelled.' } } : m,
    ));
  }

  return (
    <div className="chat-layout">
      <div className="chat-header">
        <div className="chat-header-left">
          <div className="chat-agent-avatar"><Bot size={18} /></div>
          <div>
            <div className="font-display text-sm font-bold">Kairo Agent</div>
            <div className="chat-agent-status">
              <span className={cx('heartbeat-dot', statusQuery.data ? 'is-live' : '')} />
              {statusQuery.isLoading ? 'connecting…' : statusQuery.data?.running ? `scanning every ${statusQuery.data.intervalSeconds}s` : statusQuery.data?.mode === 'demo' ? 'demo mode' : 'paper mode · idle'}
            </div>
          </div>
        </div>
        <div className={cx('mode-pill', statusQuery.data?.mode === 'demo' ? 'is-demo' : 'is-paper')}>
          <span className="mode-pill-dot" />
          {statusQuery.data?.mode === 'demo' ? 'DEMO' : 'PAPER'}
        </div>
      </div>

      <div className="chat-messages">
        {messages.map((msg) => (
          <Bubble
            key={msg.id}
            msg={msg}
            onConfirmOrder={(preview) => confirmOrder(msg.id, preview)}
            onCancelOrder={() => cancelOrder(msg.id)}
            confirming={confirming === msg.id}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="chat-suggestions">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chat-suggestion-chip" onClick={() => send(s)}>{s}</button>
        ))}
      </div>

      <div className="chat-input-row">
        <input
          ref={inputRef}
          className="chat-input"
          placeholder="Ask anything or say 'buy 10 SPY'…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
        />
        <button
          className="button button-primary chat-send-btn"
          onClick={() => send(input)}
          disabled={!input.trim()}
          aria-label="Send"
        >
          <Send size={15} />
        </button>
      </div>
    </div>
  );
}
