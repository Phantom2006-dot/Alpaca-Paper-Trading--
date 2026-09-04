# PowerPoint Prompt Guide: Kairo AI Trading Agent

Use this guide with a presentation generator to create a product, demo, investor, hackathon, or stakeholder presentation about Kairo.

## Product facts

Kairo is an explainable, paper-only AI trading agent built on Alpaca Markets. It scans market data, creates a trade thesis, evaluates deterministic risk gates, proposes or executes paper orders, and records the decision trail.

Kairo has two linked user experiences:

1. **Kairo web cockpit** - an authenticated React/Vite operator workspace for dashboard monitoring, strategy research, backtesting, paper execution, risk controls, credentials, and audit review.
2. **Telegram bot** - a conversational alternative for users who prefer Telegram: https://t.me/Superrhhbot

The web app and Telegram are two access channels for the same product direction. Telegram should be presented as an alternate way to interact with the agent, not as a separate live brokerage or a replacement for the web risk controls.

## Non-negotiable claims

- Paper trading only. The execution adapter is locked to `paper-api.alpaca.markets`.
- No live order routing exists in the product.
- Users authenticate before entering the web dashboard.
- The public web landing page is available at `/`.
- Web Launch App, Start for free, and pricing actions open authentication and route a signed-in user to `/dashboard`.
- Agent API routes require authenticated Clerk bearer tokens.
- Alpaca credentials are user-provided paper credentials and are stored server-side in memory, scoped to the authenticated Clerk user.
- Demo mode works without Alpaca credentials using deterministic synthetic data.
- Do not claim guaranteed returns, financial advice, autonomous live trading, or production-grade persistence.

## Copy-and-paste master prompt

Create a polished [presentation type] PowerPoint presentation titled **"Kairo: Explainable Paper Trading Through Web and Telegram"** for [audience]. The presentation should be [number] slides and take approximately [duration] minutes.

Explain that Kairo is a paper-only AI trading agent built on Alpaca Markets. Its core value is not a black-box buy/sell signal; it shows the market evidence, thesis, risk gates, proposed action, execution result, and audit trail so an operator can understand every decision.

Present the product as two connected channels:

- The authenticated Kairo web cockpit at `/`, with the dashboard at `/dashboard`.
- The linked Telegram bot at https://t.me/Superrhhbot for conversational access.

Show a clear user journey: discover Kairo on the public landing page, choose Launch App or Start for free, authenticate with Clerk, arrive at the dashboard, configure paper credentials if needed, research or run a strategy, inspect risk gates, and review the audit trail. Show Telegram as an alternate entry point for users who want to interact conversationally.

Cover the two strategy modes accurately:

- Z-score + ADX mean reversion: 20-bar mean and standard deviation, entry at absolute Z-score of at least 2.0, ADX below 25, volume ratio at least 1.0x, 2% trailing stop, and hard invalidation at 3.5 sigma.
- ICT / HMM 5-cluster mode: a 3-state regime classifier plus ICT/SMC features such as fair value gaps, break of structure, change of character, liquidity sweeps, and displacement, with an AWD gate of at least 0.65.

Explain the seven-step console flow: Market Ingestion, Multi-Indicator Analysis, AI Thesis Generation, Deterministic Risk Gates, Trade Proposal, Alpaca Paper Execution, and Post-Run Result.

Include the safety model: paper-only routing, authenticated API access, user-scoped credentials, idempotency keys, duplicate-position checks, position caps, trailing stops, hard invalidation, paper URL validation, and the HALT kill switch that stops automation and flattens paper positions.

Use a confident but factual tone. Do not promise profit or imply that AI removes trading risk. Make the Telegram channel feel useful and approachable while making it clear that the web cockpit is the primary operator surface for detailed research, controls, and auditability.

## Recommended slide structure

1. **Title** - Kairo name, one-line promise, web and Telegram channel labels.
2. **The problem** - Trading automation is difficult to inspect, explain, and control.
3. **The product** - Kairo turns strategy decisions into a visible paper-trading workflow.
4. **Two ways in** - Side-by-side web cockpit and Telegram Minisbot journey, with the shared paper-only boundary.
5. **From landing page to dashboard** - Launch App -> Clerk authentication -> dashboard -> strategy and account controls.
6. **How the agent reasons** - Market evidence, indicators, thesis, gates, proposal, paper execution, audit.
7. **Strategy engines** - Z-score + ADX and ICT / HMM 5-cluster mode.
8. **Risk and safety** - Guardrails, authentication, paper lock, kill switch, and credential isolation.
9. **Operator experience** - Dashboard, Console, Strategy, Backtest, Risk, Account, Credentials, and Audit pages.
10. **Telegram workflow** - How a user who prefers Telegram reaches the linked Minisbot experience and when the web cockpit is useful.
11. **Technical architecture** - React/Vite browser, Clerk authentication, Express API, strategy engine, generated OpenAPI client, and Alpaca paper API.
12. **Demo or closing** - A concise end-to-end demo checklist and the product takeaway: visible decisions, bounded execution, two convenient channels.

## Visual direction

Use a modern fintech control-room aesthetic: graphite or near-black interface surfaces, warm off-white typography, restrained green for approved paper actions, amber for warnings, and red only for rejection or kill-switch states. Use a distinctive editorial display font for headings and a readable sans-serif for body text. Avoid generic stock-market photos, crypto imagery, profit charts implying guaranteed returns, and purple-gradient startup visuals.

Prefer product screenshots or faithful UI mockups: public landing page, Clerk sign-in moment, dashboard metrics, seven-step console, risk gate checklist, audit detail, and the Telegram chat surface. Use arrows and short labels to show the connection between web and Telegram. Keep each slide focused on one idea with no more than three or four short points.

Use diagrams for flow and architecture rather than dense paragraphs. Use a small sample trade journey with clearly labeled fictional or demo values. Any chart must say `illustrative` or `demo data` when it is not sourced from a live account.

## Speaker notes prompt

For every slide, add speaker notes containing: the main point in one sentence, a 30-60 second explanation, one product fact supporting the claim, and one sentence clarifying that Kairo is paper-only. For the Telegram slide, mention https://t.me/Superrhhbot exactly and explain that it is the alternate conversational channel linked to the web product.

## Demo presentation variant

Create a 7-slide live demo deck:

1. Kairo overview and paper-only boundary.
2. Public landing page: click Launch App or Start for free.
3. Clerk authentication and dashboard arrival.
4. Credentials page and user-scoped paper credential handling.
5. Console seven-step decision pipeline.
6. Telegram alternative at https://t.me/Superrhhbot.
7. Risk controls, audit trail, and closing takeaway.

Keep the demo narrative chronological. Never display real API keys, secrets, account numbers, or private user data in screenshots.

## Review checklist

Before accepting the generated presentation, confirm that:

- The web app and Telegram are both included and clearly linked conceptually.
- The Telegram URL is exactly https://t.me/Superrhhbot.
- Launch App and Start for free are described as authentication-aware actions.
- The public `/` landing page is distinguished from the authenticated `/dashboard`.
- Paper-only execution is visible on the title, safety, and closing slides.
- No slide promises returns or calls Kairo a live trading bot.
- Clerk is described as authentication, not as the trading engine.
- Alpaca is described as the paper-market data and execution provider.
- Strategy names and guardrail values match the product facts above.
- Screenshots contain no secrets.
- Technical details support the story instead of overwhelming the audience.
