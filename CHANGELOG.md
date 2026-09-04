# Changelog — Alpaca AI Trading Agent

All completed work is recorded here after every prompt request.

---

## [Session 6] — Route Restructure: / → Landing, /dashboard → App

### Completed
- `/` now renders `LandingPage` (standalone, no Shell)
- `/dashboard` now renders `DashboardPage` inside Shell
- All internal nav, logo, back-links, pricing CTAs, landing hero/footer updated to `/dashboard`
- Activity feed "View audit" link corrected from `/activity` to `/audit`
- `vite.config.ts` replaced with clean local config (removed Replit-specific `PORT`/`BASE_PATH` env guards and Replit plugins)
- Missing Windows native binaries manually installed: `@rollup/rollup-win32-x64-msvc`, `lightningcss-win32-x64-msvc`, `@tailwindcss/oxide-win32-x64-msvc`
- TypeScript typecheck: clean (exit 0)

### Files modified
- `artifacts/alpaca-agent/src/App.tsx` — Router restructure, all href updates
- `artifacts/alpaca-agent/vite.config.ts` — replaced with clean local config

---

## [Session 5] — Full Hackathon UI Implementation

### Completed
- **Backend**: Idempotency key store (60s TTL, duplicate rejection), paper URL guard (`paperUrlValid` field in `getStatus()`), `AuditRun` type with `runId/latencyMs/modelName/outcome/raw JSON blobs`, `getAuditRuns()` export, `submitEntry` refactored to return raw data (no double-logging), `runStrategy` enriched with full audit metadata per symbol
- **SSE endpoint**: `GET /api/agent/console/stream` — streams 7-step pipeline events as `text/event-stream` with real indicator values from `runStrategy`
- **Audit endpoint**: `GET /api/agent/audit` — returns all `AuditRun` records
- **Shell upgrades**: Agent status badge (`ONLINE/IDLE/ANALYZING/HALTED`), persistent `🟡 PAPER TRADING ONLY` badge, `🛑 KILL` button, `KillSwitchModal` (type HALT confirmation), halt banner on flatten
- **Nav**: Updated to 8 items — Dashboard, AI Console, Strategy, Backtester, Audit Trail, Risk Engine, Account, Architecture
- **`/console`** (`ConsolePage`): 7-step SSE pipeline stepper with 4 states (pending/active/success/rejected), Decision Inspector panel (IndicatorBox, ThesisCard, RiskGatesGrid, ProposalCard, ExecutionCard), step nav dots
- **`/audit`** (`AuditPage`): Split-screen master-detail, filter bar (symbol/outcome/runId), collapsible JSON inspector panels for all 4 raw payloads
- **`/risk`** (`RiskPage`): Full risk rule matrix (9 rules), kill switch sequence card, paper lock card
- **`/architecture`** (`ArchitecturePage`): SVG directed graph (5 nodes, 6 edges, animated), node inspector sheet with model/schema/tools
- **CSS**: All new component styles appended to `index.css`

### Files modified
- `artifacts/api-server/src/lib/strategy.ts` — idempotency, audit records, submitEntry refactor, runStrategy enrichment, getAuditRuns, paperUrlValid
- `artifacts/api-server/src/routes/agent.ts` — SSE stream endpoint, audit endpoint
- `artifacts/alpaca-agent/src/App.tsx` — new imports, navItems, Shell rewrite, Router new routes
- `artifacts/alpaca-agent/src/pages/ConsolePage.tsx` — created
- `artifacts/alpaca-agent/src/pages/AuditPage.tsx` — created
- `artifacts/alpaca-agent/src/pages/RiskPage.tsx` — created
- `artifacts/alpaca-agent/src/pages/ArchitecturePage.tsx` — created
- `artifacts/alpaca-agent/src/components/KillSwitchModal.tsx` — created
- `artifacts/alpaca-agent/src/index.css` — Shell, modal, console, audit, risk, architecture CSS appended

---

## [Session 4] — Landing Page + Full Frontend Implementation

### Completed
- Built full marketing landing page at `/landing` route (outside app shell, no sidebar)
- Added `framer-motion` animations: `fadeUp`, `stagger`, `viewport` scroll triggers throughout
- **Sections**: Animated ticker bar, sticky nav, hero (terminal mockup), features (6 cards), how it works (4 steps), what we offer (Z-score vs ICT/HMM), pricing (3 tiers), footer
- **Pricing tiers**: Free ($0), Pro ($29/mo), Institutional (custom)
- Router restructured: `/landing` renders standalone, all app routes nested inside `Shell`
- All landing styles appended to `index.css` (dark theme, responsive, hover states)

### Files modified
- `artifacts/alpaca-agent/src/App.tsx` — framer-motion import, landing page components, router restructure
- `artifacts/alpaca-agent/src/index.css` — all landing page CSS appended

---


**Status**: COMPLETE

### What was done
Full merge of PowerX ICT/SMC + HMM 5-cluster engine into the Alpaca-Paper-Trading-- TypeScript repo as a pure TypeScript port. No Python sidecar, no FastAPI, no extra process.

### Files modified
- `artifacts/api-server/src/lib/strategy.ts` — Added `classifyRegimeHmm()`, `extractSmcFeatures()`, `tmaSlopeApprox()`, `routeCluster()`. Wired `strategyMode: StrategyMode` through `snapshotFromBars`, `runStrategy`, `runBacktest`, `startAgent`, `runAutomationCycle`, `scheduleAutomationCycle`. Fixed `getStatus()` bug (was returning `DEFAULT_SYMBOLS`, now returns `automationSymbols`).
- `artifacts/api-server/src/routes/agent.ts` — Wired `strategyMode` from request body into `startAgent`, `runStrategy`, `runBacktest` handlers.
- `lib/api-spec/openapi.yaml` — Added `cluster` (nullable string) to `SymbolSnapshot`. Expanded `regime` enum with `expansion`, `retracement`, `consolidation`. Added `strategyMode` to `RunStrategyInput`, `AgentAutomationInput`, `BacktestInput`.
- `lib/api-zod/src/generated/api.ts` — Updated all Zod schemas to match new spec.
- `artifacts/alpaca-agent/src/App.tsx` — Added `Cluster` column to `SnapshotTable`. Added strategy mode dropdown to `DashboardPage`. Wired `strategyMode` into `runStrategy` and `startAgent` mutations.

### Architecture
- Default: `strategyMode: "zscore"` — Z-score mean-reversion + ADX (unchanged behaviour)
- Opt-in: `strategyMode: "ict_hmm"` — HMM regime classifier + ICT/SMC features + 5-cluster router (AWD gate ≥ 0.65)
- Demo mode preserved: both strategy modes work with `demoBars()` sine-wave data
- Paper lock preserved: `PAPER_TRADING_URL` hardcoded, `paper=true` enforced

---

## [Session 1] — Project Onboarding & Architecture Review

### Completed
- Full architecture review of PowerX (nanobot fork): 9-layer breakdown documented.
- Full code review of `nanobot/trading/` + `nanobot/agent/tools/alpaca_trade.py`: 30+ findings logged.
- Security fix: removed hardcoded API key `PKVUBWO7D6ZR6USUZNCB2NDKTC` from `SKILL.md`, rewrote to v1.1.0.
- Cloned `https://github.com/Phantom2006-dot/Alpaca-Paper-Trading--.git` to local builds folder.
- Created `.agents/memory/MEMORY.md` with full dual-repo context.
- Designed complete merge plan (6 steps, each independently committable).

### Memory Bank
- `.agents/memory/MEMORY.md` — created and populated with full context of both repos.

---

## [Session 2] — Hold Confirmation + Changelog Bootstrap

### Completed
- Confirmed merge plan is ON HOLD.
- Active strategy locked to Z-score mean-reversion + ADX (default, no changes to code).
- ICT/SMC + HMM 5-cluster strategy queued as opt-in switch when hold is lifted.
- Created this `CHANGELOG.md`.
- Updated `.agents/memory/MEMORY.md` with hold status and changelog standing instruction.

### Standing Instructions Confirmed
- Save completed work to `CHANGELOG.md` after every prompt request.
- Always update `.agents/memory/MEMORY.md` after every task.
- Paper trading lock (`paper=true`, `PAPER_TRADING_URL`) must never be removed.
- No credentials in source — env vars and Supabase AES-GCM only.
- Codegen must re-run after any `openapi.yaml` change.
