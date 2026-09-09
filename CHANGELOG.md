# Changelog — Alpaca AI Trading Agent

All completed work is recorded here after every prompt request.

---

## [Session 10] — Production error diagnosis: encryption key, PowerX outage, backtest cascade (FIXES + KEY MAP)

> **For the next LLM:** the user hit three errors in production. All three were diagnosed with real probes
> (env pulls, live curl to upstreams, DB connection attempts) — zero assumptions. Root causes below.

### Errors reported → root causes found (verified, not guessed)
1. **"Persistence requires CREDENTIALS_ENCRYPTION_KEY…" when saving credentials**
   → The `CREDENTIALS_ENCRYPTION_KEY` env var on the Vercel **kairo-api** production project was a **placeholder string, not a real key** (11 chars of literal `[SENSITIVE]` placeholder text). `canEncrypt()` correctly rejected it. **FIX APPLIED:** generated a fresh 32-byte key (`crypto.randomBytes(32).toString('hex')` → 64 hex chars) and set it via `vercel env rm` + `vercel env add CREDENTIALS_ENCRYPTION_KEY production` on the **kairo-api** project. Redeploy required (env vars bind at deploy).
   ⚠️ NOTE: any credential rows written under a previous *valid* key would now be `unreadable` — but since the key was never valid, **no rows existed and nothing was lost** (DB was also unreachable, see below).
2. **"PowerX API 503: upstream connect error / connection termination" when chatting**
   → Probed the upstream directly (`curl https://http--powerx-app--cmttpj77q5vc.code.run/v1/chat/completions`, 4 attempts): the **PowerX Cloud Run app itself returns HTTP 503 on every request** — it is down/crashed/scaled-to-zero, independent of our API. The old Render endpoint (`minis-yzdb.onrender.com`) is also 503. **NOT fixable in this repo** — the PowerX deployment must be restarted/redeployed by whoever owns it. **Code improvement applied:** `lib/powerx.ts` now detects Envoy/gateway 503 signatures (`upstream connect error`, `connection termination`, `no healthy upstream`, empty body) and returns *"PowerX service is unavailable (upstream 503 from <host>). The PowerX deployment is down or restarting — check its service health, then retry."* instead of the cryptic proxy text. All 20 unit tests still pass.
3. **"Alpaca credentials are required for backtesting"**
   → Not an independent bug: `fetchHistoricalBars()`/optimizer legitimately require real per-user Alpaca keys (`hasCredentials()`), and saving keys was failing due to #1. **Fixing #1 unblocks this.** After redeploy: save keys on the Credentials page → backtest works with real Alpaca data (`data.alpaca.markets/v2/stocks/{symbol}/bars`, feed=iex).

### Where every key/secret lives (exact, verified via `vercel env ls` on both projects)
| Key | Vercel project | Environment(s) | Set by | Notes |
|---|---|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | **kairo-api** | Production | **Me, this session** (32-byte hex, stored as Vercel Secret — hidden, not pullable) | AES-256-GCM key for encrypting user Alpaca keys in Postgres. NEVER change it after real keys are stored (rows become `unreadable`) |
| `DATABASE_URL` | **kairo-api** | Production | User (⚠️ value appears to be a placeholder — **DB hostname did not resolve: `getaddrinfo ENOTFOUND`**). Replace with a real pooled Postgres URL (e.g. Neon/Supabase) for persistence to work | Lazy-DDL `alpaca_credentials` table lives here |
| `POWERX_API_TOKEN` | **kairo-api** | Production | User (Vercel Secret) | Bearer token for the PowerX AI upstream; sent server-side only |
| `CLERK_SECRET_KEY` | **kairo-api** | Production | User | Clerk backend auth |
| `CLERK_PUBLISHABLE_KEY` | **kairo-api** | Production | User | Not currently read by API code |
| `CORS_ORIGINS` | **kairo-api** | Production | User | Comma-separated frontend origin allowlist |
| `VITE_API_URL` | **kairo** | Production | User | Backend base URL baked into frontend at build time |
| `VITE_CLERK_PUBLISHABLE_KEY` | **kairo** | Production | User | Clerk frontend |
| `CLERK_SECRET_KEY`, `POWERX_API_TOKEN` | **kairo** | Production | User | ⚠️ **Not needed on the frontend project** (frontend never uses them) — can be deleted for hygiene |
| Your **Alpaca paper keys** | **Not stored anywhere yet** | — | You, via Credentials page → encrypted into Postgres | Verification hits `paper-api.alpaca.markets/v2/account` live |
| `.env.local` files on disk | root + `artifacts/alpaca-agent/` | local dev | — | Contain only `VITE_*`/Clerk publishable values; **gitignored** (verified) |

**Action still needed from the user (cannot be done from here):**
- Replace `DATABASE_URL` on **kairo-api** with a real Postgres connection string (current one doesn't resolve).
- Restart/redeploy the PowerX Cloud Run service to fix the AI chat 503 (or set `POWERX_API_URL` to a live deployment).
- Redeploy **kairo-api** (`vercel deploy --prod` from repo root) so the new encryption key takes effect, then save Alpaca keys in the UI.

### Files modified this session
- `artifacts/api-server/src/lib/powerx.ts` — actionable upstream-outage error message
- `CHANGELOG.md` — this entry
- **Vercel kairo-api env:** `CREDENTIALS_ENCRYPTION_KEY` replaced with a valid 32-byte key

---

## [Session 9] — Frontend↔backend interface audit, PowerX AI hardening, credential persistence safety (CURRENT STATE)

> **Read this first (context for any LLM picking this up):** The app is "Kairo", an Alpaca **paper-only** AI trading agent.
> Monorepo: `artifacts/api-server` (Express 5 API, Vercel serverless), `artifacts/alpaca-agent` (React/Vite frontend),
> `lib/api-spec` + `lib/api-zod` + `lib/api-client-react` (OpenAPI → Orval → Zod contract, shared client), `scripts/` (PowerX CLI helper).
> Deployment = **two separate Vercel projects**: repo root `vercel.json` serves only the API (rewrite `/* → /api/index`, `maxDuration` 60s);
> `artifacts/alpaca-agent/vercel.json` serves the SPA from `dist/public`.

### 1. What was verified end-to-end (audit result)

**Frontend ↔ Backend interfacing — OK**
- Frontend bootstraps the generated client in `src/main.tsx`: `setBaseUrl(import.meta.env.VITE_API_URL)` + `setAuthTokenGetter(getToken)` (Clerk JWT), set synchronously before first render to avoid a race where queries fire against the wrong origin.
- All React Query hooks come from `@workspace/api-client-react` (Orval-generated from `lib/api-spec/openapi.yaml`) and call `/api/agent/*` paths — the contract is shared, so schema drift is caught at compile time on both sides.
- `ChatPage.tsx` does two direct `fetch` calls outside the generated client, both with Clerk bearer token attached manually: `POST /api/agent/powerx` (AI chat) and `POST /api/agent/trade` (order placement). Both paths exist in `routes/agent.ts`.
- SSE console: `GET /api/agent/console/stream` sets **explicit** CORS headers inside the route handler (Vercel edge does not reliably propagate `cors()` middleware headers on streaming responses) plus an `OPTIONS` preflight handler using the same `isOriginAllowed` allowlist from `lib/cors.ts` (env-driven via `CORS_ORIGINS`/`CORS_ORIGIN`).
- Auth gate in `app.ts`: `ALLOW_LOCAL_DEV_AUTH=true` bypasses Clerk (local dev only) otherwise `clerkMiddleware()`; 401 without userId; `/agent/credentials` resolves its own userId, everything else flows through `withUserCredentials(userId)` which loads creds (Postgres AES-256-GCM → 30s memory cache → demo fallback) and binds them via AsyncLocalStorage.

**AI chat (PowerX) — OK, hardened this session**
- `POST /api/agent/powerx` is a **server-side proxy**: `POWERX_API_TOKEN` never reaches the browser.
- `lib/powerx.ts` was rewritten this session: default endpoint moved from `https://minis-yzdb.onrender.com/v1/chat/completions` to `https://http--powerx-app--cmttpj77q5vc.code.run/v1`; URL/model/timeouts now env-driven (`POWERX_API_URL`, `POWERX_MODEL`, `POWERX_REQUEST_TIMEOUT_MS`, `POWERX_POLL_INTERVAL_MS`, `POWERX_POLL_TIMEOUT_MS`).
- Every outbound call has an `AbortController` timeout (15s default). Polling: async responses are detected by `status: processing|queued|pending|in_progress`; the poll URL is taken from `Location` header or `poll_url`/`status_url`/`result_url`/`url` body fields and is **origin-pinned to the configured PowerX origin (SSRF guard)**; poll loop has its own deadline (30s default). `poll` now defaults to **true** server-side (`req.body?.poll !== false`).
- Response parsing is defensive: OpenAI `choices[].message.content` (string or content-parts array), plus `result`/`response`/`data` nesting, plus top-level `content`. "Service suspended" responses produce an actionable error message.
- Chat personality: when `agentContext` is provided, a system prompt injects live Kairo state (mode, equity, cash, open positions, running/symbols/lastRunAt) so the AI answers from real account data. Frontend `ChatPage` has a deterministic local intent parser (portfolio, status, buy/sell with order confirmation flow, strategy explainers) and only falls back to PowerX for unknown intents.

**Alpaca paper trading + ETFs/stocks + historical data — OK**
- `PAPER_TRADING_URL = https://paper-api.alpaca.markets` is hardcoded (reference: https://docs.alpaca.markets/us/docs/paper-trading). `getStatus()` includes `paperUrlValid` guard. **No live-trading path exists — keep it that way** (standing rule from Session 2).
- Orders go to `POST /v2/orders` with a `client_order_id`; a 60s-TTL idempotency map rejects duplicate submissions; kill-switch `POST /agent/flatten` closes everything.
- Asset universe: `GET /v2/assets?status=active&tradable=true&asset_class=us_equity` — covers **ETFs and stocks** (default demo universe `SPY, QQQ, IWM, AAPL` — three ETFs + one stock; frontend asset search hits this endpoint).
- Market data (reference: https://docs.alpaca.markets/us/docs/getting-started-with-alpaca-market-data): `GET https://data.alpaca.markets/v2/stocks/{symbol}/bars` with `feed=iex` (free plan compatible), timeframes, 60 latest bars for live scanning; `fetchHistoricalBars()` (start/end, limit 1000) powers backtests (`/agent/backtest`) and the 72-candidate grid optimizer (`/agent/optimize`, 50s deadline). Without credentials everything runs on deterministic synthetic sine-wave demo data.
- Strategy engines: Z-score mean-reversion (entry |Z|≥2σ, ADX<25, volume≥1×, invalidation 3.5σ, 2% trailing stop) and ICT/HMM 5-cluster mode. All decisions logged to activity feed + audit trail.

### 2. Changes made this session (uncommitted at time of writing)
- `api/index.ts`, `api/agent/[...path].ts` — fixed broken relative import: re-exports were pointing at `../../artifacts/api-server/dist/vercel.mjs` from a file that lives one level deep; corrected to `../artifacts/api-server/dist/vercel.mjs`. This was breaking the Vercel API deploy.
- `artifacts/api-server/src/lib/credentials.ts` — **persistence is now fail-closed**: when `DATABASE_URL` is configured, credentials are NOT activated in memory until the encrypted DB write succeeds (previously a failed persistence looked successful on warm serverless instances and keys silently vanished on next instance). New `configuration_error` tri-state: `DATABASE_URL` set but `CREDENTIALS_ENCRYPTION_KEY` missing/invalid → status reports the misconfiguration instead of pretending demo mode; `loadCredentials` returns null (demo data) in that case. `memory` state is only reported when no DB is configured.
- `artifacts/api-server/src/lib/powerx.ts` — full rewrite as described above (new endpoint, env-driven config, timeouts, SSRF-guarded polling, defensive parsing, actionable errors).
- `artifacts/api-server/src/routes/agent.ts` — PowerX route: polling enabled by default.
- `artifacts/alpaca-agent/src/pages/CredentialsPage.tsx` — handles the new `configuration_error` status with an explanatory banner (set `CREDENTIALS_ENCRYPTION_KEY`, re-enter keys).
- `scripts/src/query-powerx.ts` — CLI helper ported to match the new client behavior.
- `artifacts/api-server/src/lib/powerx.test.ts` — **new test file** (4 cases: sync content, poll flow without repeating POST, rejection of async-without-poll-URL, no request without token).

### 3. Validation performed this session (all green)
- `node --test` in `artifacts/api-server`: **20/20 unit tests pass** (crypto round-trip/rotation, credential isolation/persistence, PowerX polling/no-token, per-user runtime scoping).
- `pnpm typecheck` (api-server, `tsc --noEmit`): clean.
- `pnpm build` (alpaca-agent, Vite): clean, 2246 modules (chunk-size warning only, non-blocking).
- `pnpm build` (api-server): clean; `dist/vercel.mjs` produced, which `api/index.ts` and `api/agent/[...path].ts` re-export.
- `.env.local` confirmed gitignored.

### 4. Known gaps / recommended next steps (ranked — from full backend audit)
1. **HIGH — automation cannot survive Vercel serverless**: `POST /agent/start` loops via in-process `setTimeout` + in-memory state; Lambda freeze/instance switch kills it. Needs a durable scheduler (Vercel Cron + a `/agent/tick` endpoint, or QStash/queue, or a long-running host) + Postgres-backed automation state.
2. **HIGH — serverless Postgres pooling**: module-scope `new Pool()` (default max:10) per instance can exhaust DB connections under Vercel concurrency. Use a pooled/pgBouncer endpoint with `max:1` or a serverless driver (Neon HTTP).
3. **HIGH — `ALLOW_LOCAL_DEV_AUTH` has no production guard**: if that env var is ever set on the API deployment, every request authenticates as `local-dev-user`. Add: refuse when `NODE_ENV === "production"`.
4. **MEDIUM — no rate limiting** on expensive endpoints (`/agent/optimize` ≈72 backtests, `/agent/powerx` paid AI calls). Add per-user throttling (e.g. Upstash Redis).
5. **MEDIUM — no outbound timeouts on Alpaca `fetch` calls** (PowerX now has them; Alpaca does not). Also `credentialsWork()` fires a live `/v2/account` call on every `/agent/status` — add a short TTL cache.
6. **MEDIUM — global idempotency map not user-scoped**: `recentIdempotencyKeys` is module-level keyed by raw key; key it `${userId}:${key}`.
7. **MEDIUM — error messages leak internals** (raw Alpaca response bodies in 500/502 payloads). Log details, return generic messages.
8. **MEDIUM — `/agent/powerx` upload limits**: `express.json()` default 100KB silently caps base64 files; set explicit limit + MIME allowlist.
9. **LOW** — side-effecting GETs (`snapshotFromBars` mutates `trailingExtremes` by hidden default); artificial ~410ms of `setTimeout` delays in the SSE pipeline; dead `routes/index.ts` + empty `middlewarew/`; `/agent/credentials` POST not Zod-validated like other routes; DDL duplicated between `credentials.ts` and Drizzle schema; no route-level/integration tests.

### 5. Environment variables (API deployment, as of this session)
| Var | Required | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` / publishable key on frontend | yes (prod) | Auth |
| `DATABASE_URL` | for persistence | Postgres for encrypted credentials |
| `CREDENTIALS_ENCRYPTION_KEY` | with DATABASE_URL | 32-byte key (64 hex chars or base64), AES-256-GCM. Rotating it marks rows `unreadable` |
| `ALPACA_API_KEY` / `ALPACA_API_SECRET` | optional env fallback | Per-user keys from Credentials page take priority |
| `POWERX_API_TOKEN` | for AI chat | Server-side only |
| `POWERX_API_URL`, `POWERX_MODEL`, `POWERX_*_TIMEOUT_MS`, `POWERX_POLL_*` | optional | Override PowerX defaults |
| `CORS_ORIGINS` / `CORS_ORIGIN` | recommended | Comma-separated frontend origin allowlist |
| `ALLOW_LOCAL_DEV_AUTH` | local dev only | ⚠️ must NEVER be set in production (gap #3) |

---

## [Session 8] — Per-user agent state, credential tri-state + status/delete, env-driven CORS

### Completed
- **Per-user agent runtime** (`strategy.ts`): all previously module-global engine state (activity trail, audit runs, demo positions, trailing extremes, automation loop, scan counters) is now scoped per Clerk user via the AsyncLocalStorage session. Users sharing one process no longer read or clobber each other's agent state. The automation timer re-enters the owning user's session each tick.
- **Credential tri-state** (`credentials.ts` + new `crypto.ts`): AES-256-GCM helpers extracted and unit-tested; status distinguishes `none` / `memory` / `database` / `unreadable` so a rotated `CREDENTIALS_ENCRYPTION_KEY` no longer masquerades as demo mode. Added a 30s in-memory TTL so status/dashboard polling does not hit Postgres on every request.
- **`GET`/`DELETE /api/agent/credentials`**: status report (no secrets — storage source, key last-4, updated-at) and removal of stored keys. Frontend Credentials page shows saved-state banner, Remove button, and unreadable warning.
- **CORS is fully env-driven**: origins read from `CORS_ORIGINS` / `CORS_ORIGIN`, with the known `.vercel.app` frontends + localhost as defaults; removed the hardcoded single-origin header from `artifacts/api-server/vercel.json` that would break a custom frontend domain.
- **Docs**: README updated with the two-Vercel-project deployment guide (`kairo` frontend + `kairo-api` backend), new endpoints, and `CORS_ORIGINS` env var.
- **Tests**: 16 `node:test` cases across `crypto`, `credentials`, and `strategy` (per-user isolation, automation scoping, demo positions). Typecheck clean for all packages.

### Files modified
- `artifacts/api-server/src/lib/credentials.ts`, `crypto.ts` (new), `strategy.ts`, `routes/agent.ts`, `app.ts`, `vercel.json`
- `artifacts/alpaca-agent/src/pages/CredentialsPage.tsx`, `src/index.css`
- `README.md`, `CHANGELOG.md`

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

## [Session 7] — Alpaca Credential Connection Fix

### Completed
- Added a process-local credential fallback so valid Alpaca credentials are not rejected when optional database or encryption configuration is unavailable.
- Kept encrypted PostgreSQL persistence when `DATABASE_URL` and a valid `CREDENTIALS_ENCRYPTION_KEY` are configured; persistence failures no longer mask successful Alpaca verification.
- Added `api/index.ts` as the hosted Express entrypoint.
- Removed the Vercel rewrite from `/api/*` to dead `localhost:8080`; `/api/*` now resolves to the serverless function while SPA routes continue to resolve to `index.html`.

### Validation
- `git diff --check` passed.
- API library, API server, and frontend TypeScript checks passed; `git diff --check` also passed.
