# Changelog — Alpaca AI Trading Agent

All completed work is recorded here after every prompt request.

---

## [Session 16] — Blank-candles bug fixed (contract violation), options-chain 404 fixed, chart time-travel (1D→1Y)

### 1. Blank candles — root cause: backend violated the API contract
- Backend returned bars as `{timestamp, open, high, low, close, volume}` (internal `Bar` shape) while the OpenAPI schema `OhlcvBar` (and therefore the generated frontend types and the chart) specifies **`{t, o, h, l, c, v}`**. The chart mapped `b.o/b.c/…` → all `undefined` → SVG rendered but nothing drawn.
- **Fix**: `getMarketBars()` now maps internal bars to the wire shape via `toWireBars()` (`WireBar` type = OhlcvBar). Contract is again the single source of truth.
- **Regression guard**: the endpoint audit script now fails if `/agent/bars` ever returns a bar missing any of `t/o/h/l/c/v` or non-numeric `o/c`.

### 2. Options chain 404 ("Options data 404: endpoint not found") — root cause: double version path
- `MARKET_DATA_URL = https://data.alpaca.markets/v2` and `getOptionChain()` appended `/v1beta1/...` → requested `data.alpaca.markets/v2/v1beta1/options/snapshots/...` → Alpaca 404.
- **Fix**: derive the host via `new URL(MARKET_DATA_URL).origin` and call `${origin}/v1beta1/options/snapshots/{underlying}?limit=100`.
- Parser made shape-tolerant: Alpaca returns `snapshots` as a **map keyed by OCC symbol** (docs pages 404'd during verification, so the parser handles map *and* array, snake_case *and* camelCase `latest_quote`/`latestQuote`). If a different shape arrives, `count: 0` + diagnostics show the raw upstream body instead of a crash.
- Note: chat/manual option orders were already correct (OCC symbol, limit-only, per paper-options docs).

### 3. Chart time-travel — new `lookback` parameter
- Spec: `/agent/bars` gained `lookback` query enum **`1D | 5D | 1M | 3M | 1Y`** (default 1M); backend bounds the Alpaca query with `start`, requests `sort=desc` + reverses so the newest `limit` bars within the window are kept.
- Frontend: green **WINDOW** tab row (1D/5D/1M/3M/1Y) under the timeframe tabs; bars query cache keyed by symbol+timeframe+lookback; limit raised 120→400 so 1Y windows stay dense.

### Deployment & verification
- Backend deployed from **repo root** (pnpm lockfile present; the nested-project deploy path re-broke npm/workspace:* in testing) → Ready, healthz OK.
- Frontend deployed prebuilt with SPA routes config `{handle: filesystem} → index.html` (deep links verified 200) and re-aliased; live bundle `index-DLvUlXvC.js` hash-verified to contain lookback tabs, order ticket, symbol search.
- Typecheck ✓ (both), 20/20 unit tests ✓, endpoint audit **10/10** (tokenless mode).

### Run Scan & Preview-only (answered, from code)
- **Run scan** = one manual strategy pass over the lane's symbols (`POST /agent/run`): fetch snapshots → compute signal → check all 6 guardrails → act. With **Preview only OFF** + credentials saved, it places real paper orders (per-user idempotency, 10% position sizing). With it **ON**, nothing orders — actions are returned as `simulated` for review (demo mode also simulates, since there's no data source without keys).
- **Preview only (dryRun) is the safe default while exploring**: OFF = real paper orders on Alpaca; ON = shadow results only.

---

## [Session 15] — Real-time quotes, endpoint truth-audit, deployment root fixed, live-bundle proof

### Backend
- **New endpoint `GET /api/agent/quote?symbol=…`** → real-time latest trade from Alpaca Data API (`/v2/stocks/{symbol}/trades/latest`, feed iex→sip fallback). Returns `{ symbol, price, size, timestamp, feed, live: true }`. No synthetic prices anywhere.
- **Endpoint truth-audit script** (`scripts/src/audit-endpoints.ts`, run: `npx tsx scripts/src/audit-endpoints.ts`) — hits all 10 live endpoints; tokenless mode verifies each auth-gated route answers 401 (proves reachability + gating); with `CLERK_TOKEN` + `ALPACA_KEY_ID/ALPACA_SECRET` set it cross-checks response bodies against Alpaca ground truth (equity match, bar-price plausibility, no placeholder win-rate 68.4/6.2, regime ≠ insufficient_data). Result on live API: **10/10 verified**.

### Frontend
- `CandleChart` header now polls `/api/agent/quote` every 5 s and shows a **LIVE price badge** next to the chart symbol (real ticks, not interpolated candles).

### Deployment root-cause fix (why recent deploys broke)
- Deploying from `artifacts/api-server/` (its `.vercel/project.json` also points to `kairo-api`) uploads **without** `pnpm-lock.yaml` → Vercel falls back to `npm install` → `workspace:*` protocol fails → build Error. **The correct deployment root is the repo root**, whose `vercel.json` pins `installCommand: pnpm install --frozen-lockfile` and builds via pnpm filter. Backend redeployed from repo root → Ready, healthz OK.
- Frontend: `vercel build --prod` died on a stale esbuild binary (host lib 0.27.3 vs downloaded binary 0.27.0; fixed with `node install.js`) but its own re-prune kept breaking vite. Deployed via **manual Build Output API** (`dist/public` → `.vercel/output/static`, `vercel deploy --prebuilt --prod`) and **explicitly re-aliased** `kairo-trade-agent.vercel.app` → new deployment.
- **Proof of live UI**: alias HTML references bundle `index-B-_zeP5R.js`, byte-identical hash to local build; greps for "Place paper order", "candlestick", "Search symbol", "Market data diagnostics" all hit in the **live** bundle.
- **SPA routes fix (POST-DEPLOY)**: the first manual prebuilt deploy omitted `routes` in `.vercel/output/config.json`, so deep links (`/dashboard`, `/chat`, …) returned 404 while `/` worked. The config **must** contain the filesystem-then-rewrite pair:
  ```json
  { "version": 3, "routes": [ { "handle": "filesystem" }, { "src": "/(.*)", "dest": "/index.html" } ] }
  ```
  Redeployed prebuilt + re-aliased. Verified live: `/`, `/dashboard`, `/chat`, `/console`, `/credentials` all **200** serving the app HTML (`<title>Alpaca Agent</title>`) with the same verified bundle. NOTE: `.vercel/` is gitignored, so future prebuilt deploys must recreate this config (or deploy from repo root where `vercel.json` rewrites exist).

### Verification (all real, no assumptions)
- Backend typecheck ✓, 20/20 unit tests ✓ (`node node_modules/.pnpm/tsx@4.23.1/node_modules/tsx/dist/cli.mjs --test artifacts/api-server/src/lib/*.test.ts`).
- Live: healthz `{"status":"ok"}`; 10/10 endpoint audit; frontend alias serves the new bundle.

---

## [Session 14] — Candlestick charts, options trading (paper), asset dropdown, market-data diagnostics ("insufficient data" fixed)

### Facts established from Alpaca docs (no assumptions)
- **Options**: paper trading supports options **by default** (docs.alpaca.markets/us/docs/options-trading: "In the Paper environment, options trading capability will be enabled by default"). Data via `data.alpaca.markets/v1beta1/options/snapshots/{underlying}`; orders via `/v2/orders` with the **OCC contract symbol** and **limit type only** (no market orders for options).
- **Futures**: Alpaca offers **no futures at all** (their forum/roadmap confirms) — nothing to integrate; stocks/ETFs were already covered.
- **Bars endpoint**: `limit` accepts 1–10000 (default 1000) — the old hard-coded 60-bar fetch was a self-imposed limitation, now configurable.

### "Insufficient data" — root cause + fix
- The scanner's `regime: insufficient_data` fired whenever `bars.length < 22` (20-bar SMA/ADX warm-up). With `feed=iex` (free plan) many symbols return **zero bars** outside market hours / for non-IEX-covered names → the regime showed "insufficient data" with no explanation.
- **Fix**: `fetchBars/getMarketBars` now default to `feed=auto` and walk the fallback order **iex → sip → delayed_sip**, returning the first feed with data (and reporting which feed was used). Every upstream failure is recorded in a diagnostics ring buffer.
- **New endpoint** `GET /api/agent/diagnostics/market-data` — recent fetch failures + feed order, so empty charts/scans are explainable instead of mysterious.

### Candlestick charts (TradingView-style, new)
- `GET /api/agent/bars?symbol&timeframe&feed&limit` returns OHLCV (open now captured too).
- New `CandleChart.tsx` component: pure-SVG candles + volume columns, price grid, sparse time axis, feed badge, 1min/5min/15min/1hour/1day selector, 60s auto-refresh, honest empty-state pointing at diagnostics. Embedded at the top of the AI Console.

### Options trading (paper) + asset selection
- **Option chain panel** on the Console: `GET /api/agent/options/{underlying}` parses OCC symbols into strike/expiry/type with bid/ask/Δ from snapshots.
- **Option orders**: `orderType: "option"` on `POST /agent/trade` (OCC symbol + limit price enforced; demo mode politely refuses). Chat parser now recognizes OCC contracts: `buy 1 SPY250919C00500000 at 1.25` → confirm card → real paper options order.
- **Asset search dropdown** in the Console controls: searches the real Alpaca `/v2/assets` universe (all stocks & ETFs) and clicking a result switches the pipeline/chart to it.

### Validation / deploy
- Codegen clean; API typecheck clean; 20/20 tests; frontend typecheck + build clean. Backend + frontend redeployed. Commit `84238d7`.

---

## [Session 13] — User confirmed DB persistence works; safest-trade advisor shipped; dummy metrics removed

### Verified by the user in the live app
- **Alpaca credentials now persist to Postgres** (via the Supabase Session Pooler URL set in Session 12) and are usable — the Session 9→12 fix chain (valid 32-byte encryption key + fail-closed persistence + IPv4 pooler host) is confirmed working end-to-end by the user.

### How the backtester works (documentation of existing code, verified by reading it)
- `POST /agent/backtest` → `runBacktest()`: fetches **real** Alpaca historical bars (`data.alpaca.markets/v2/stocks/{symbol}/bars`, start/end, limit 1000, feed=iex, requires credentials — demo mode intentionally refuses), needs ≥22 bars per symbol.
- Replays bar-by-bar **causally**: for each bar index ≥21 it builds a snapshot from only past data (`bars.slice(0, i+1)`), computes Z-score/ADX/volume (or ICT/HMM features in ict_hmm mode), and applies the exact same six guardrails as live trading (entryZ=2, adxMax=25, minVolumeRatio=1, invalidationZ=3.5, maxPositionPct=10, trailing stop 2%).
- Simulated fills: capital split equally across symbols, position size = capital × maxPositionPct / price; exits on `exit` (Z crosses 0) or `invalidation` (|Z|≥3.5 / trailing stop); per-symbol FIFO tracking.
- Outputs: equity curve, per-trade P&L + return% + exit reason, win rate, max drawdown, benchmark comparison (first vs last close).
- `POST /agent/optimize` → runs the same engine over a 72-candidate grid of guardrail thresholds with a 50s deadline and returns the ranked candidates (score = return − drawdown penalty). Nothing is persisted; no orders are placed.

### Safest-trade advisor (NEW — the "what should I take?" feature)
- **Contract**: `GET /agent/suggestions` (`TradeSuggestions`/`TradeSuggestion` schemas in openapi.yaml; Orval client regenerated).
- **Backend** `getTradeSuggestions()` in `strategy.ts`: scans the default universe (SPY, QQQ, IWM, AAPL) with live Alpaca bars, keeps only candidates that (a) emit a long/short entry signal, (b) pass all six deterministic guardrails, and (c) have no open position; ranks by a conservative **safety score (0–100)**: Z-excess margin (8–25), ADX headroom (≤15 → +25), volume confirmation (+12/+20), distance-to-mean (≥2% → +15), invalidation buffer (≥1σ → +15). Grades A ≥75, B ≥55, else C. Includes warnings (marginal Z, weak volume, near-invalidation, near-mean), proposed qty from real equity × 10% cap, stop at ±2%, target = 20-bar mean. Returns top 5 + disclaimer. No orders placed, nothing stored.
- **Frontend**: ChatPage gained an `advice` intent ("what trades do you suggest?", "safest", "recommend", "what should I buy/sell"…) that calls the endpoint directly — **works without PowerX**; replies are formatted with grades, levels, rationale, warnings, and a one-tap next step ("buy N SYM"). Suggestion chip "What trades do you suggest?" added.

### Dummy data removed (user mandate: no fake numbers)
- `getDashboard()` previously returned hardcoded `winRate: 68.4` / `avgHoldHours: 6.2` (flagged in repo memory as placeholder). Replaced with `getRealizedMetrics()`: fetches up to 500 closed orders from Alpaca `/v2/orders?status=closed`, builds FIFO round-trips per symbol (sell closes oldest buy lot), computes real win rate and average hold hours. Zero-history → zeros + explanatory `note`; the OpenAPI `metrics` schema gained `realizedTradeCount` + nullable `note` so the UI can be honest about "not enough data" instead of showing invented percentages.

### Trading capability map (all verified in code; user should confirm in UI)
- **Manual trades**: chat ("buy 5 SPY" → confirm card) and `/agent/trade` → `placeManualTrade()` → real `POST paper-api.alpaca.markets/v2/orders` with `client_order_id` idempotency; market and limit orders; time-in-force `day`.
- **Holding positions**: Alpaca is the source of truth (`GET /v2/positions` rendered in Account/Dashboard); the agent tracks per-symbol state and will not stack duplicates; kill switch `POST /agent/flatten` closes everything.
- **History**: Account page = 50 most recent orders (`/v2/orders?status=all&limit=50`); Audit trail = every run decision with full JSON payloads; Activity feed = live event stream. All from real Alpaca data or real run records — no placeholders.

### Deployments / validation
- API typecheck clean, 20/20 tests pass, both builds succeed. Backend redeployed (`kairo-api-xi.vercel.app` Ready; `/api/agent/suggestions` correctly 401 unauthenticated), frontend redeployed prebuilt. Commit `0e4d3d6` pushed.

---

## [Session 12] — DATABASE_URL set by user (pooler), backend redeployed, live checks green

- **User completed the DB fix:** replaced `DATABASE_URL` on Vercel **kairo-api** with the Supabase **Session Pooler** connection string (IPv4-reachable, per the Session 11 verification). The exact value is Sensitive-hidden and was not inspected — trusting the user's confirmation.
- **Backend redeployed** (`vercel deploy --prod`): `kairo-api-xi.vercel.app` Ready. Live checks: `/api/healthz` → `{"status":"ok"}`; `/api/agent/credentials` → 401 (Clerk auth gate working, as expected for an unauthenticated probe); frontend `kairo-trade-agent.vercel.app` → HTTP 200.
- **Deferred by user:** PowerX (chat AI) — upstream backend restart + fresh `px_…` token will be supplied later. Chat remains 503-with-actionable-message until then; everything else (portfolio chat intents, paper orders, scans, backtests) does not depend on PowerX.
- **Next verification (needs a logged-in browser session, cannot be done from CLI):** save Alpaca paper keys on the Credentials page. Expected flow now: Alpaca live verification → AES-256-GCM encrypt → INSERT into `alpaca_credentials` via the pooler → status shows `database` + key last-4 → backtests unlock with real `data.alpaca.markets` historical bars. If a DB error still appears, the pooler string format is the suspect (username must be `postgres.<ref>`, password percent-encoded).

---

## [Session 11] — DNS-verified root causes: Supabase IPv6-only host (DB) + PowerX gateway probe matrix

### Database (`getaddrinfo ENOTFOUND db.wjuuxkgvggmuhecnwmzg.supabase.co`) — VERIFIED, fix known
- Authoritative DNS check via Google DoH: the Supabase **direct** host `db.wjuuxkgvggmuhecnwmzg.supabase.co` has **NO IPv4 A records — IPv6 (AAAA) only**. Vercel serverless functions cannot dial IPv6 → `ENOTFOUND` is permanent for this hostname. Confirmed via Google DoH `dns.google/resolve`, and cross-checked that the Supabase **pooler** host `aws-0-us-east-1.pooler.supabase.com` **has IPv4 A records** (44.216.29.125, 44.208.221.186, 52.45.94.125).
- **Fix (user action):** Supabase dashboard → Connect → **Session pooler** → copy the string `postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres` (note the `postgres.<ref>` username format), then `vercel env add DATABASE_URL production` on **kairo-api** and redeploy. User chose to paste the DB password but has not yet provided it — awaiting it to complete this step.
- **Code improvement shipped:** `lib/credentials.ts` now translates raw `getaddrinfo ENOTFOUND` into actionable guidance (explains the Supabase IPv6-only direct-host issue and points to the pooler string format) on both the table-creation and persistence error paths. 20/20 tests pass, typecheck clean.

### PowerX (`http--powerx-app--cmttpj77q5vc.code.run`) — FULL PROBE MATRIX, both failures are upstream-side
- URL is already the code default (nothing to replace — verified in `lib/powerx.ts` + `scripts/src/query-powerx.ts`).
- With the user's real token (`px_…` from their own script): `GET /v1/models` + Bearer → **200 OK** listing `powerx-agent`; GET root → 200. Gateway and TLS are alive.
- `POST /v1/chat/completions` → **503 "upstream connect error / connection termination" 12+ times over several minutes, with and without auth** — the AI backend **behind the gateway is down**. No auth style fixes it.
- Auth-style matrix on GET chat/completions (with and without payload): Bearer header, `token=` query, `x-api-key` header, `apikey=` query — all reach auth; with payload the gateway replies **401 "Invalid API key"** (Bearer/token/x-api-key) or **401 "Provide your px_... key via Authorization: Bearer"** (x-api-key) → the `px_…` token is **not valid on this gateway** (it likely belongs to the retired Render deployment `minis-yzdb.onrender.com`, which is also 503).
- Polling: already fully implemented in `queryPowerX()` (processing-status detection + poll-URL follow). Polling cannot begin because requests are rejected before a job is created — upstream must be restarted and the correct token supplied.
- **Blocked on the PowerX owner:** restart the AI backend behind the gateway AND issue a valid `px_…` token for it; then set `POWERX_API_TOKEN` on kairo-api. Nothing in this repo can substitute for that.

### Commits
- DB error-message improvement (`lib/credentials.ts`) + this entry.

---

## [Session 10] — Production error diagnosis: encryption key, PowerX outage, backtest cascade (FIXES + KEY MAP)

> **For the next LLM:** the user hit three errors in production. All three were diagnosed with real probes
> (env pulls, live curl to upstreams, DB connection attempts) — zero assumptions. Root causes below.

### Errors reported → root causes found (verified, not guessed)
1. **"Persistence requires CREDENTIALS_ENCRYPTION_KEY…" when saving credentials**
   → The `CREDENTIALS_ENCRYPTION_KEY` env var on the Vercel **kairo-api** production project was a **placeholder string, not a real key** (11 chars of literal `[SENSITIVE]` placeholder text). `canEncrypt()` correctly rejected it. **FIX APPLIED:** generated a fresh 32-byte key (`crypto.randomBytes(32).toString('hex')` → 64 hex chars) and set it via `vercel env rm` + `vercel env add CREDENTIALS_ENCRYPTION_KEY production` on the **kairo-api** project. Redeploy required (env vars bind at deploy).
   ⚠️ NOTE: the previous value could not be read back (Vercel Sensitive vars are hidden from pulls — they come back as the literal `[SENSITIVE]`), so it is unknown whether it was a wrong-format value or simply not yet bound to a deployment. Either way, the freshly generated valid key is now live. No credentials were ever successfully saved before (saves always failed), so nothing was lost by the rotation.
2. **"PowerX API 503: upstream connect error / connection termination" when chatting**
   → Probed the upstream directly (`curl https://http--powerx-app--cmttpj77q5vc.code.run/v1/chat/completions`, 4 attempts): the **PowerX Cloud Run app itself returns HTTP 503 on every request** — it is down/crashed/scaled-to-zero, independent of our API. The old Render endpoint (`minis-yzdb.onrender.com`) is also 503. **NOT fixable in this repo** — the PowerX deployment must be restarted/redeployed by whoever owns it. **Code improvement applied:** `lib/powerx.ts` now detects Envoy/gateway 503 signatures (`upstream connect error`, `connection termination`, `no healthy upstream`, empty body) and returns *"PowerX service is unavailable (upstream 503 from <host>). The PowerX deployment is down or restarting — check its service health, then retry."* instead of the cryptic proxy text. All 20 unit tests still pass.
3. **"Alpaca credentials are required for backtesting"**
   → Not an independent bug: `fetchHistoricalBars()`/optimizer legitimately require real per-user Alpaca keys (`hasCredentials()`), and saving keys was failing due to #1. **Fixing #1 unblocks this.** After redeploy: save keys on the Credentials page → backtest works with real Alpaca data (`data.alpaca.markets/v2/stocks/{symbol}/bars`, feed=iex).

### Where every key/secret lives (exact, verified via `vercel env ls` on both projects)
| Key | Vercel project | Environment(s) | Set by | Notes |
|---|---|---|---|---|
| `CREDENTIALS_ENCRYPTION_KEY` | **kairo-api** | Production | **Replaced by me this session** with a freshly generated 32-byte key (64 hex chars, stored as Vercel Secret — hidden, not pullable) | AES-256-GCM key for encrypting user Alpaca keys in Postgres. NEVER change it again after real keys are stored (rows become `unreadable`). The previous value could not be inspected (Vercel Sensitive vars pull as `[SENSITIVE]`), but the live save error proved `canEncrypt()` was false on the old deployment — the new key removes that failure mode |
| `DATABASE_URL` | **kairo-api** | Production | User (⚠️ **unverifiable from outside** — Vercel Sensitive vars pull as the literal `[SENSITIVE]`, so the real value could not be inspected or connectivity-tested. An earlier probe that reported `ENOTFOUND` ran against the redacted placeholder, **not** the real URL, and is retracted) | If it is not a valid pooled Postgres URL, credential saves will fail with *"Credential storage is unavailable…"* — that error (instead of the encryption-key error) is the signal to fix it. The lazy-DDL `alpaca_credentials` table lives here |
| `POWERX_API_TOKEN` | **kairo-api** | Production | User (Vercel Secret) | Bearer token for the PowerX AI upstream; sent server-side only |
| `CLERK_SECRET_KEY` | **kairo-api** | Production | User | Clerk backend auth |
| `CLERK_PUBLISHABLE_KEY` | **kairo-api** | Production | User | Not currently read by API code |
| `CORS_ORIGINS` | **kairo-api** | Production | User | Comma-separated frontend origin allowlist |
| `VITE_API_URL` | **kairo** | Production | User | Backend base URL baked into frontend at build time |
| `VITE_CLERK_PUBLISHABLE_KEY` | **kairo** | Production | User | Clerk frontend |
| `CLERK_SECRET_KEY`, `POWERX_API_TOKEN` | **kairo** | Production | User | ⚠️ **Not needed on the frontend project** (frontend never uses them) — can be deleted for hygiene |
| Your **Alpaca paper keys** | **Not stored anywhere yet** | — | You, via Credentials page → encrypted into Postgres | Verification hits `paper-api.alpaca.markets/v2/account` live |
| `.env.local` files on disk | root + `artifacts/alpaca-agent/` | local dev | — | Contain only `VITE_*`/Clerk publishable values; **gitignored** (verified) |

**Action still needed from the user (cannot be done or verified from here):**
- Confirm `DATABASE_URL` on **kairo-api** is a real Postgres connection string (it is Sensitive-hidden, so it cannot be inspected or pinged from the CLI). Test: save Alpaca keys in the UI — if you now get *"Credential storage is unavailable…"* instead of success, the URL is bad. No DB configured at all → keys stay session-only in memory.
- Restart/redeploy the PowerX Cloud Run service to fix the AI chat 503 (or set `POWERX_API_URL` to a live deployment). This is an upstream outage — verified with direct probes, nothing in this repo can fix it.
- Then: save your Alpaca **paper** keys on the Credentials page (real verification against `paper-api.alpaca.markets/v2/account`), after which backtesting uses real Alpaca historical bars.

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
