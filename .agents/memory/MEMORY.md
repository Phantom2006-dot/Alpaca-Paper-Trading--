# Project Memory Bank
_Last updated: after repo pull task_

---

## Session Log

### Session 1 — Architecture Review (PowerX / nanobot fork)
- Full codebase review of PowerX (nanobot fork with custom trading engine).
- Produced 9-layer architecture breakdown: AgentLoop, AgentRunner, Provider Abstraction, Tool System, Trading Engine, Skills System, Session & Memory, Channels & Gateway, Deployment.
- Absorbed 7 external skills via `npx skills use`.

### Session 2 — SKILL.md Security Fix
- Removed hardcoded API key `PKVUBWO7D6ZR6USUZNCB2NDKTC` from `nanobot/skills/alpaca-hackathon/SKILL.md`.
- Rewrote to v1.1.0: table-driven, credential resolution via env/Supabase only.

### Session 3 — Full Trading Engine Code Review
- Full scan of `nanobot/trading/` + `nanobot/agent/tools/alpaca_trade.py`.
- 30+ findings. Critical: inline credential exposure in `/alpaca connect`, partial key leak in status response, `delete_credentials()` always returns `True`, module-level `WatchManager` singleton breaks multi-worker deployments.
- Medium: `directional_bias` inversion undocumented, `_backtest_text()` ignores timeframe arg, Cluster A/B truthy-int signal check, `get_bars()` MultiIndex drop unsafe.
- Low: `load_market_data()` discards partial results, `nb_tma()` null-propagation on single bad candle, equity curve CSV has duplicate rows.

### Session 4 — Repo Pull: Alpaca-Paper-Trading--
- Cloned `https://github.com/Phantom2006-dot/Alpaca-Paper-Trading--.git`
- Local path: `c:\Users\DELL\Documents\chinaza\builds\Alpaca-Paper-Trading--`
- Latest commit: `2c9f473 work automated entry and exit of trades` (2 commits ahead of initial)
- Branch: `main`

---

## Repo: Alpaca-Paper-Trading-- (the frontend/API repo)

### What it is
A **TypeScript-first** explainable AI paper-trading cockpit. Separate from the Python nanobot/PowerX engine. Built on Replit, deployed as a pnpm workspace monorepo.

### Stack
- **Runtime**: Node.js 24, TypeScript 5.9, pnpm workspaces
- **API server**: Express 5 (`artifacts/api-server/`) — port 8080
- **Frontend**: React + Vite (`artifacts/alpaca-agent/`) — port 24492
- **DB**: PostgreSQL + Drizzle ORM (`lib/db/`) — not used by agent routes yet
- **Validation**: Zod v4 + `drizzle-zod`
- **API contract**: OpenAPI 3.1 spec at `lib/api-spec/openapi.yaml` — source of truth
- **Codegen**: Orval generates `lib/api-client-react/` (React hooks) and `lib/api-zod/` (Zod schemas) from the spec
- **Build**: esbuild (CJS bundle)

### Workspace Packages
| Package | Path | Role |
|---|---|---|
| `@workspace/alpaca-agent` | `artifacts/alpaca-agent/` | React operator cockpit |
| `@workspace/api-server` | `artifacts/api-server/` | Express API + strategy engine |
| `@workspace/api-spec` | `lib/api-spec/` | OpenAPI spec + Orval config |
| `@workspace/api-client-react` | `lib/api-client-react/` | Generated React query hooks |
| `@workspace/api-zod` | `lib/api-zod/` | Generated Zod request/response schemas |
| `@workspace/db` | `lib/db/` | Drizzle schema + migrations |
| `@workspace/scripts` | `scripts/` | Dev scripts |

### Key Files
- `artifacts/api-server/src/lib/strategy.ts` — **entire strategy engine**: guardrails, demo lane, Alpaca adapter, backtest, optimization, automation loop
- `artifacts/api-server/src/routes/agent.ts` — all Express route handlers (thin, delegates to strategy.ts)
- `lib/api-spec/openapi.yaml` — API contract (13 endpoints)
- `artifacts/alpaca-agent/src/` — React cockpit (components, hooks, pages)
- `artifacts/mockup-sandbox/` — design mockup sandbox (separate Vite app)

### API Endpoints (from openapi.yaml)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/healthz` | Health check |
| GET | `/api/agent/dashboard` | Full dashboard: account + snapshots + activity + metrics |
| GET | `/api/agent/status` | Agent running state + guardrails |
| POST | `/api/agent/start` | Start continuous automation loop |
| POST | `/api/agent/stop` | Stop automation loop |
| GET | `/api/agent/assets` | Search tradable Alpaca assets |
| GET | `/api/agent/account` | Account + positions + orders |
| POST | `/api/agent/run` | One-shot strategy scan |
| POST | `/api/agent/flatten` | Close all paper positions |
| GET | `/api/agent/market/:symbol` | Per-symbol indicator snapshot |
| POST | `/api/agent/backtest` | Historical backtest |
| POST | `/api/agent/optimize` | Grid-search threshold optimization |

### Strategy Engine (strategy.ts) — Key Design Points
- **Demo mode**: no credentials → uses `demoBars()` (deterministic sine-wave data), `demoPositions` Map, `demoAssets` list. Zero external calls.
- **Paper mode**: `ALPACA_API_KEY` + `ALPACA_API_SECRET` env vars present → real Alpaca paper API calls.
- **Paper lock**: `paper=true` is enforced by using `PAPER_TRADING_URL = "https://paper-api.alpaca.markets"` hardcoded. No live trading URL exists in the codebase.
- **Strategy**: Mean-reversion Z-score on 20-bar SMA/stddev. Entry at `|Z| ≥ entryZ (default 2.0)`. Exit at `Z ≥ exitZ (default 0)`. Hard invalidation at `|Z| ≥ 3.5`. ADX filter blocks trending regimes. Volume ratio filter blocks low-liquidity entries.
- **Guardrails object** (all configurable per run):
  - `entryZ: 2`, `exitZ: 0`, `invalidationZ: 3.5`
  - `adxMax: 25`, `minVolumeRatio: 1`, `maxPositionPct: 10`
  - `trailingStop: true` (2% trailing from extreme)
  - `duplicatePositionCheck: true`, `paperOnly: true`
- **Automation**: `setTimeout`-based loop. `automationCycleInFlight` flag prevents overlapping cycles. State is module-level (single-process only).
- **Backtest**: Event-driven bar-by-bar simulation. Allocates `initialCapital / nSymbols` per symbol. Tracks equity curve for max drawdown. Closes open positions at end-of-data.
- **Optimization**: Grid search over `entryZ × adxMax × minVolumeRatio` (6×4×3 = 72 candidates). Score = `returnPct - 0.5 × maxDrawdownPct`. Returns top 10 leaderboard.
- **`winRate: 68.4` and `avgHoldHours: 6.2` in getDashboard() are hardcoded placeholder values** — not computed from real trade history.

### Known Issues / Gotchas
- `winRate` and `avgHoldHours` in dashboard metrics are hardcoded (`68.4` and `6.2`). Not real.
- `automationRunning` and all automation state are module-level globals — breaks in multi-process/cluster deployments (same issue as Python `WatchManager`).
- `getStatus()` always returns `symbols: DEFAULT_SYMBOLS` regardless of what `automationSymbols` is set to. Bug: should return `automationSymbols`.
- `closePosition()` activity status for invalidation is `"blocked"` not `"closed"` — semantically wrong per the OpenAPI enum (`blocked` means entry was blocked, not that a position was closed).
- `fetchBars()` hardcodes `limit: "60"` — only 60 bars fetched for live snapshots. ADX needs 14+, Z-score needs 20+, so this is fine, but leaves no buffer for gaps.
- `runBacktest()` returns only `trades.slice(-100)` — last 100 trades only. Long backtests silently truncate the trade list.
- No rate limiting on any API endpoint. `/agent/optimize` runs 72 backtests synchronously — can block the event loop for minutes.
- No authentication on any route. Any caller can trigger paper orders or flatten positions.
- `DATABASE_URL` / Drizzle schema exists but agent routes do not persist anything to DB. Activity log is in-memory only (lost on restart).

### Commands
```bash
# Start everything
pnpm --filter @workspace/api-server run dev   # API on :8080
pnpm --filter @workspace/alpaca-agent run dev  # UI on :24492

# Regenerate API client + Zod schemas from openapi.yaml
pnpm --filter @workspace/api-spec run codegen

# Typecheck all packages
pnpm run typecheck

# Build all
pnpm run build

# Push DB schema (dev only)
pnpm --filter @workspace/db run push
```

### Environment Variables
| Var | Required | Purpose |
|---|---|---|
| `ALPACA_API_KEY` | Optional | Enables paper mode; absent = demo mode |
| `ALPACA_API_SECRET` | Optional | Enables paper mode |
| `DATABASE_URL` | Optional | DB tooling only; not used by agent routes |

---

## Repo: PowerX / nanobot fork (the Python engine)

### Local path
`c:\Users\DELL\Documents\chinaza\builds\powerx-main (1)\powerx-main`

### Key trading modules
| File | Role |
|---|---|
| `nanobot/trading/alpaca_adapter.py` | Alpaca paper adapter (`paper=True` hardcoded) |
| `nanobot/trading/analyst_agent.py` | 3-state GaussianHMM regime classifier |
| `nanobot/trading/scout_agent.py` | ICT/SMC feature extraction via `smartmoneyconcepts` |
| `nanobot/trading/strategy_router.py` | 5-cluster router (A–E), AWD gate ≥ 0.65 |
| `nanobot/trading/risk_manager.py` | Daily loss lock (5R), spread filter, stop-distance check |
| `nanobot/trading/backtest_engine.py` | Event-driven closed-bar-causal backtest |
| `nanobot/trading/tma_engine.py` | NB-TMA slope + Wilder ATR + basket correlation |
| `nanobot/trading/alpaca_credentials.py` | AES-GCM encrypted per-user keys in Supabase |
| `nanobot/trading/polling_engine.py` | Async price-watch loops + Supabase persistence |
| `nanobot/trading/trading_commands.py` | Telegram `/trade` and `/backtest` handlers |
| `nanobot/trading/alpaca_commands.py` | Telegram `/alpaca connect/disconnect/status` |
| `nanobot/agent/tools/alpaca_trade.py` | nanobot tool: buy/sell/positions/account/close |
| `nanobot/skills/alpaca-hackathon/SKILL.md` | Strategy playbook (v1.1.0, no hardcoded keys) |

### AWD Formula
`AWD = 0.45 × HMM_confidence + 0.35 × TMA_slope_strength + 0.20 × volatility_score`
Minimum threshold: **0.65**

### Five Strategy Clusters
| Cluster | Trigger |
|---|---|
| A — Institutional Reversal | Liquidity sweep + CHoCH + sponsorship |
| B — Trend Expansion | BoS + HMM Expansion + displacement |
| C — Value Retracement | FVG + inducement + killzone |
| D — Correlation Basket | TMA extreme + Consolidation + basket correlation ≥ 0.25 |
| E — Range Liquidity | Killzone + Consolidation |

---

## Standing Instructions
- **Always create/update this memory bank after every task.**
- **Always update `CHANGELOG.md` (repo root) after every completed prompt request.**
- Memory bank lives at: `c:\Users\DELL\Documents\chinaza\builds\Alpaca-Paper-Trading--\.agents\memory\MEMORY.md`
- Changelog lives at: `c:\Users\DELL\Documents\chinaza\builds\Alpaca-Paper-Trading--\CHANGELOG.md`
- Paper trading lock must never be removed from either repo.
- Never hardcode API keys in any file.
- Before writing code: read the relevant files first.
- Codegen must be re-run (`pnpm --filter @workspace/api-spec run codegen`) after any `openapi.yaml` change.

## Current Plan Status
- **PLAN MODE**: Alpaca AI Trading Agent Frontend — **SESSION 5 COMPLETE**
- **Merge plan (Python sidecar)**: COMPLETE — pure TypeScript port, no sidecar needed.
- **Active strategy**: Z-score mean-reversion + ADX (default, `strategyMode: "zscore"`).
- **Switchable strategy**: ICT/SMC + HMM 5-cluster live as `strategyMode: "ict_hmm"` — selectable from the dashboard dropdown.
- **New routes**: `/console`, `/audit`, `/risk`, `/architecture` — all implemented.
- **Kill switch**: Global modal with HALT confirmation, flattens positions + stops agent.
- **SSE pipeline**: `GET /api/agent/console/stream` streams 7-step events with real indicator data.
- **Audit trail**: `GET /api/agent/audit` returns enriched `AuditRun` records with raw JSON payloads.
- **Idempotency**: `crypto.randomUUID()` per console run, 60s TTL duplicate rejection on server.
- **Paper URL guard**: `paperUrlValid` field in `getStatus()` response.


### Session 7 — Alpaca Credential Connection Fix
- Confirmed the active repository is `Phantom2006-dot/Alpaca-Paper-Trading--`; the similarly named repository without the trailing `--` is empty.
- Root cause 1: Vercel rewrote `/api/*` requests to `http://localhost:8080`, which is not reachable in hosted production.
- Root cause 2: credential verification succeeded against Alpaca, but saving then failed whenever `DATABASE_URL`, `CREDENTIALS_ENCRYPTION_KEY`, or the credentials table was unavailable; this surfaced to the UI as a connection failure.
- Root cause 3 risk check: per-user credentials are loaded through `withUserCredentials()` in the Express middleware; this path remains intact.
- Fix: added `api/index.ts`, removed the localhost Vercel rewrite, and changed credential storage to use an in-memory per-process fallback while retaining encrypted PostgreSQL persistence when configured.
- Validation completed: library project references, API server, frontend, and `git diff --check` all passed. The package manager still reports a local blocked esbuild lifecycle script, but it does not affect these checks.
