# Alpaca Agent

An explainable AI-assisted Alpaca paper-trading agent that researches, scans, and executes only within visible paper-account guardrails.

## Run & Operate

- Use the **Alpaca Agent** workflow or the Replit Run button — starts the API on port 8080 and the Vite cockpit on port 24492.
- `PORT=8080 pnpm --filter @workspace/api-server run dev` — run only the API server.
- `API_PORT=8080 PORT=24492 BASE_PATH=/ pnpm --filter @workspace/alpaca-agent run dev` — run only the cockpit against the local API.
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- No external credentials are required for demo mode.
- Optional paper-account env: `ALPACA_API_KEY` and `ALPACA_API_SECRET`. Their presence enables Alpaca paper-account data, paper orders, historical backtests, and optimization; the execution adapter remains locked to Alpaca's paper API.
- `DATABASE_URL` is required only for database tooling; the current agent routes do not use the database.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/alpaca-agent/` — React/Vite operator cockpit.
- `artifacts/api-server/src/lib/strategy.ts` — agent strategy, paper adapter, guardrails, demo lane, backtests, and decision activity.
- `artifacts/api-server/src/routes/agent.ts` — agent API routes.
- `lib/api-spec/openapi.yaml` — API contract source of truth.
- `lib/api-client-react/` and `lib/api-zod/` — generated browser hooks and server validation.

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
