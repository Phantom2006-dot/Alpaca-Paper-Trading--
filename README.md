# Kairo AI Trading Agent

An explainable, paper-only AI trading cockpit built on Alpaca Markets. Kairo scans market data, formulates a thesis, passes every decision through deterministic risk gates, executes paper orders, and exposes an audit trail in real time.

Kairo has two linked entry points:

- **Web cockpit:** authenticated research, strategy, risk, paper execution, credentials, and audit workspace.
- **Telegram bot:** <https://t.me/Superrhhbot> for users who prefer a conversational workflow.

Users can choose either channel. The web Launch App and Start for free actions open authentication first, then route a successfully authenticated user to `/dashboard`. Telegram is an alternate interface and does not enable live trading.

> **Paper trading only.** The execution adapter is hardcoded to `paper-api.alpaca.markets`. No live order routing exists anywhere in this codebase.

---

## What it does

The agent runs one of two strategy engines on a configurable symbol universe, applies a layered guardrail stack, and streams every decision step to the operator console:

| Strategy | Description |
|---|---|
| **Z-score + ADX** (default) | Mean-reversion on 20-bar SMA/stddev. Entry at `\|Z\| ≥ 2.0σ`, exit at equilibrium. ADX < 25 and volume ratio ≥ 1× required. 2% trailing stop. Hard invalidation at 3.5σ. |
| **ICT / HMM 5-cluster** (opt-in) | 3-state HMM regime classifier (Expansion / Retracement / Consolidation) + ICT/SMC feature extraction (FVG, BoS, CHoCH, liquidity sweep, displacement). AWD gate ≥ 0.65. Routes to one of 5 clusters (A–E). |

Both modes work in **demo mode** (no credentials) using deterministic sine-wave data.

---

## Architecture

```
Browser (React/Vite :24492)
        │
        │  REST + SSE
        ▼
API Server (Express 5 :8080)
        │
        ├── strategy.ts  ← entire strategy engine (Z-score + ICT/HMM)
        ├── routes/agent.ts  ← all 14 endpoints
        └── Alpaca Paper API  ← paper-api.alpaca.markets only
```

### Workspace packages

| Package | Path | Role |
|---|---|---|
| `@workspace/alpaca-agent` | `artifacts/alpaca-agent/` | React operator cockpit |
| `@workspace/api-server` | `artifacts/api-server/` | Express API + strategy engine |
| `@workspace/api-spec` | `lib/api-spec/` | OpenAPI 3.1 spec + Orval config |
| `@workspace/api-client-react` | `lib/api-client-react/` | Generated React Query hooks |
| `@workspace/api-zod` | `lib/api-zod/` | Generated Zod request/response schemas |
| `@workspace/db` | `lib/db/` | Drizzle schema + migrations |

### API endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/healthz` | Health check |
| `GET` | `/api/agent/dashboard` | Account + snapshots + activity + metrics |
| `GET` | `/api/agent/status` | Agent state + guardrails + `paperUrlValid` |
| `POST` | `/api/agent/start` | Start continuous automation loop |
| `POST` | `/api/agent/stop` | Stop automation loop |
| `GET` | `/api/agent/assets` | Search tradable Alpaca assets |
| `GET` | `/api/agent/account` | Account + positions + orders |
| `POST` | `/api/agent/run` | One-shot strategy scan |
| `POST` | `/api/agent/flatten` | Close all paper positions |
| `GET` | `/api/agent/market/:symbol` | Per-symbol indicator snapshot |
| `POST` | `/api/agent/backtest` | Historical backtest |
| `POST` | `/api/agent/optimize` | Grid-search threshold optimization (72 candidates) |
| `GET` | `/api/agent/audit` | All audit run records |
| `GET` | `/api/agent/console/stream` | SSE pipeline stream (7 steps) |
| `POST` | `/api/agent/credentials` | Store paper credentials in memory for the signed-in user |

---

## UI pages

| Route | Description |
|---|---|
| `/` | Public landing page — features, pricing, web launch, and Telegram entry point |
| `/dashboard` | Authenticated dashboard — account strip, metrics rail, symbol scanner, activity feed |
| `/console` | **AI Agent Console** — 7-step SSE pipeline stepper with live Decision Inspector |
| `/strategy` | Strategy logic — flow diagram, guardrail matrix, operator scan controls |
| `/backtest` | Historical backtester — date range, capital, timeframe, optimizer |
| `/audit` | Audit trail — split-screen master-detail with raw JSON inspector |
| `/risk` | Risk engine — 9-rule matrix, kill switch sequence, paper lock card |
| `/architecture` | System architecture — SVG directed graph with node inspector |
| `/account` | Account & orders — positions table, order history |

### AI Agent Console (hero view)

The console streams a 7-step pipeline in real time via Server-Sent Events:

```
[1. Market Ingestion]
  → [2. Multi-Indicator Analysis]
    → [3. AI Thesis Generation]
      → [4. Deterministic Risk Gates]
        → [5. Trade Proposal]
          → [6. Alpaca Paper Execution]
            → [7. Post-Run Result]
```

Each step has four states: **pending → active → success → rejected**. The Decision Inspector panel updates live with indicator values, AI thesis, risk gate checklist, and the final verdict banner.

### Kill Switch

The `🛑 KILL` button in the topbar opens a confirmation modal. Typing `HALT` flattens all paper positions, stops the automation loop, and locks the UI with a flashing halt banner.

---

## Guardrails

| Rule | Default | Description |
|---|---|---|
| Entry Z-score | ≥ 2.0σ | Minimum distance from 20-bar mean |
| Exit Z-score | ≤ 0.0σ | Return to equilibrium |
| Hard invalidation | ≥ 3.5σ | Immediate close on extreme deviation |
| ADX filter | < 25 | Block entries in trending regimes |
| Volume ratio | ≥ 1.0× | Require above-average volume |
| Max position | 10% equity | Per-symbol position cap |
| Trailing stop | 2% | From position extreme |
| Duplicate check | on | One position per symbol |
| Paper-only lock | hardcoded | Cannot be disabled |

---

## Getting started

### Prerequisites

- Node.js 24+
- pnpm 9+

### Install

```bash
pnpm install
```

### Run (development)

```bash
# API server on :8080
pnpm --filter @workspace/api-server run dev

# React cockpit on :24492
pnpm --filter @workspace/alpaca-agent run dev
```

No credentials required — demo mode uses synthetic sine-wave data automatically.

### Run with Clerk authentication and an Alpaca paper account

Create `artifacts/alpaca-agent/.env.local` for the Vite app:

```bash
VITE_CLERK_PUBLISHABLE_KEY=<your_clerk_publishable_key>
```

Set these variables before starting the API server:

```bash
CLERK_SECRET_KEY=<your_clerk_secret_key>
ALPACA_API_KEY=<your_paper_key>
ALPACA_API_SECRET=<your_paper_secret>
```

The public landing page still renders if the Vite key is missing, but authenticated app routes require Clerk when the key is configured. Alpaca credentials entered in the Credentials page are stored in server memory and scoped to the signed-in Clerk user. The execution adapter remains locked to `paper-api.alpaca.markets`.

### Build

```bash
pnpm run build
```

### Typecheck

```bash
pnpm run typecheck
```

### Regenerate API client + Zod schemas

Run this after any change to `lib/api-spec/openapi.yaml`:

```bash
pnpm --filter @workspace/api-spec run codegen
```

### Push DB schema (dev only)

```bash
pnpm --filter @workspace/db run push
```

---

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `ALPACA_API_KEY` | Optional | Enables paper mode; absent = demo mode |
| `ALPACA_API_SECRET` | Optional | Enables paper mode |
| `CLERK_SECRET_KEY` | Required for protected API routes | Verifies Clerk bearer tokens |
| `VITE_CLERK_PUBLISHABLE_KEY` | Optional local fallback; required for sign-in | Enables Clerk in the Vite app; stored in `artifacts/alpaca-agent/.env.local` |
| `DATABASE_URL` | Optional | DB tooling only; not used by agent routes |
| `PORT` | Optional | API server port (default: 8080) |

---

## Stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 24, TypeScript 5.9 |
| Package manager | pnpm workspaces |
| API server | Express 5 |
| Frontend | React 19 + Vite |
| Styling | Tailwind CSS v4 + custom CSS layer |
| Animations | framer-motion |
| Charts | Recharts |
| UI primitives | Radix UI |
| Routing | Wouter |
| Data fetching | TanStack React Query |
| Validation | Zod v4 + drizzle-zod |
| API contract | OpenAPI 3.1 (Orval codegen) |
| Database | PostgreSQL + Drizzle ORM |
| Build | esbuild (CJS bundle) |

---

## Project structure

```
Alpaca-Paper-Trading--/
├── artifacts/
│   ├── alpaca-agent/          # React operator cockpit
│   │   └── src/
│   │       ├── pages/         # ConsolePage, AuditPage, RiskPage, ArchitecturePage
│   │       ├── components/    # KillSwitchModal, UI primitives
│   │       ├── App.tsx        # Shell, routing, all page components
│   │       └── index.css      # Full design system
│   └── api-server/            # Express API + strategy engine
│       └── src/
│           ├── lib/
│           │   └── strategy.ts  # Entire strategy engine
│           └── routes/
│               └── agent.ts     # All 14 API route handlers
├── lib/
│   ├── api-spec/openapi.yaml  # API contract (source of truth)
│   ├── api-client-react/      # Generated React Query hooks
│   ├── api-zod/               # Generated Zod schemas
│   └── db/                    # Drizzle schema
├── .agents/memory/MEMORY.md   # Agent memory bank
└── CHANGELOG.md               # Session-by-session change log
```

---

## Safety constraints

- **Paper lock is hardcoded.** `PAPER_TRADING_URL = "https://paper-api.alpaca.markets"` in `strategy.ts` and `paper=true` in the Alpaca adapter. There is no code path to live trading.
- **No credentials in source.** All Alpaca keys are read from environment variables only. No key appears in any source file.
- **Idempotency keys.** Every order submission carries a `crypto.randomUUID()` client order ID. The server rejects duplicate keys within a 60-second window.
- **Paper URL guard.** `getStatus()` returns `paperUrlValid: boolean`. The frontend disables execution if this is false.
- **Kill switch.** Requires typing `HALT` to confirm. Flattens all positions, stops the automation loop, and locks the UI.

---

## Known limitations

- All agent state (activity log, audit runs, automation state) is in-memory and lost on server restart. The PostgreSQL/Drizzle DB is wired but not yet used by agent routes.
- `winRate` (68.4%) and `avgHoldHours` (6.2h) in dashboard metrics are placeholder values, not computed from real trade history.
- The optimization endpoint (`POST /agent/optimize`) runs 72 sequential backtests synchronously and can block the event loop for several minutes on large date ranges.
- Clerk protects the agent API routes. Keep `CLERK_SECRET_KEY` server-side and never commit `.env.local` files.

---

## License

MIT
