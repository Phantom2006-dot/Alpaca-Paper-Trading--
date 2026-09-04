# Alpaca Agent

An explainable AI-assisted Alpaca paper-trading agent that researches, scans, and executes only within visible paper-account guardrails.

## Run & Operate

- Use the managed workflows `artifacts/api-server: API Server` and `artifacts/alpaca-agent: web` to run the API and cockpit preview together.
- `pnpm --filter @workspace/api-server run dev` — run the API server locally (managed port 8080)
- `pnpm --filter @workspace/alpaca-agent run dev` — run the cockpit locally (managed port 24492)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `ALPACA_API_KEY`, and `ALPACA_API_SECRET` — the Alpaca credentials must be for a paper account.

The control room can start and stop the continuous paper agent. Starting runs an immediate scan when the market is open, then evaluates the configured symbols on the selected cadence. Stopping cancels future scans without flattening existing positions; use the separate Flatten control for that.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/alpaca-agent` — React/Vite operator cockpit and paper-agent controls.
- `artifacts/api-server/src/lib/strategy.ts` — strategy indicators, guardrails, paper execution, and continuous scheduler.
- `artifacts/api-server/src/routes/agent.ts` — agent, account, scan, and continuous-control routes.
- `lib/api-spec/openapi.yaml` — source of truth for API contracts.
- `lib/db/src/schema` — database schema source.

## Architecture decisions

- The product is an AI trading agent first, not a generic Alpaca administration console; Alpaca controls exist to give the agent a safe, explainable operating surface.
- Paper-only execution is a hard product boundary. Backtests and optimization never call order endpoints, and live actions remain visibly gated as paper actions.
- Strategy decisions should remain inspectable: asset scope, market data, thresholds, signals, blocks, and resulting paper actions must be visible to the operator.
- Alpaca historical data and account state are accessed through the API server; browser code uses the generated OpenAPI client rather than handling credentials.

## Product

The app gives operators an explainable AI agent cockpit: choose a tradable asset universe, tune and research the strategy, run paper-only scans, inspect account/position/order state, and review the decision trail. New capabilities should strengthen the agent's reasoning, safety, and explainability rather than turn the app into a bare brokerage dashboard.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
