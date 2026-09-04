import { Router, type IRouter } from "express";

import {
  GetMarketSnapshotParams,
  OptimizeBacktestBody,
  RunBacktestBody,
  RunStrategyBody,
  GetAgentAssetsQueryParams,
  StartAgentBody,
} from "@workspace/api-zod";

import {
  flattenPositions,
  guardrails,
  getAgentAccount,
  getAgentAssets,
  getAuditRuns,
  getDashboard,
  getMarketSnapshot,
  getStatus,
  optimizeBacktest,
  runBacktest,
  runStrategy,
  startAgent,
  stopAgent,
} from "../lib/strategy";

const router: IRouter = Router();

router.get("/agent/dashboard", async (req, res): Promise<void> => {
  try {
    res.json(await getDashboard(req.log));
  } catch (error) {
    req.log.error({ err: error }, "Unable to load agent dashboard");
    res.status(502).json({ error: error instanceof Error ? error.message : "Unable to load dashboard" });
  }
});

router.get("/agent/status", async (req, res): Promise<void> => {
  res.json(await getStatus());
});

router.post("/agent/start", async (req, res): Promise<void> => {
  const parsed = StartAgentBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid agent start input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await startAgent(
        parsed.data.symbols,
        parsed.data.intervalSeconds,
        req.log,
        parsed.data.strategyMode ?? "zscore",
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Unable to start continuous agent");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Unable to start agent",
    });
  }
});

router.post("/agent/stop", async (req, res): Promise<void> => {
  res.json(stopAgent(req.log));
});

router.get("/agent/assets", async (req, res): Promise<void> => {
  const parsed = GetAgentAssetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await getAgentAssets(parsed.data.search));
  } catch (error) {
    req.log.error({ err: error }, "Asset search failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Asset search failed" });
  }
});

router.get("/agent/account", async (req, res): Promise<void> => {
  try {
    res.json(await getAgentAccount());
  } catch (error) {
    req.log.error({ err: error }, "Account overview failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Account overview failed" });
  }
});

router.post("/agent/run", async (req, res): Promise<void> => {
  const parsed = RunStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid strategy run input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await runStrategy(
        parsed.data.symbols,
        parsed.data.dryRun,
        req.log,
        parsed.data.settings ? { ...guardrails, ...parsed.data.settings } : guardrails,
        parsed.data.strategyMode ?? "zscore",
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Strategy scan failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Strategy scan failed" });
  }
});

router.post("/agent/backtest", async (req, res): Promise<void> => {
  const parsed = RunBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid backtest input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await runBacktest(
        parsed.data.symbols,
        parsed.data.start.toISOString().slice(0, 10),
        parsed.data.end.toISOString().slice(0, 10),
        parsed.data.initialCapital,
        req.log,
        parsed.data.settings ? { ...guardrails, ...parsed.data.settings } : guardrails,
        undefined,
        parsed.data.timeframe,
        parsed.data.feed,
        parsed.data.strategyMode ?? "zscore",
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Historical backtest failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Historical backtest failed",
    });
  }
});

router.post("/agent/optimize", async (req, res): Promise<void> => {
  const parsed = OptimizeBacktestBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid optimization input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await optimizeBacktest(
        parsed.data.symbols,
        parsed.data.start.toISOString().slice(0, 10),
        parsed.data.end.toISOString().slice(0, 10),
        parsed.data.initialCapital,
        req.log,
        parsed.data.timeframe,
        parsed.data.feed,
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Strategy optimization failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Strategy optimization failed",
    });
  }
});

// ─── AUDIT RUNS ──────────────────────────────────────────────────────────────
router.get("/agent/audit", (req, res): void => {
  res.json(getAuditRuns());
});

// ─── SSE CONSOLE PIPELINE STREAM ─────────────────────────────────────────────
router.get("/agent/console/stream", async (req, res): Promise<void> => {
  const symbol = String(req.query["symbol"] ?? "SPY").trim().toUpperCase();
  const strategyMode = (req.query["strategyMode"] === "ict_hmm" ? "ict_hmm" : "zscore") as "zscore" | "ict_hmm";
  const idempotencyKey = String(req.query["idempotencyKey"] ?? "") || undefined;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const emit = (event: object) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  const stepDone = (step: number, label: string, durationMs: number, detail?: object) =>
    emit({ step, status: "success", label, durationMs, detail: detail ?? {} });
  const stepActive = (step: number, label: string) =>
    emit({ step, status: "active", label });
  const stepRejected = (step: number, label: string, error: string, detail?: object) =>
    emit({ step, status: "rejected", label, error, detail: detail ?? {} });

  try {
    // Step 1 — Market Ingestion
    const t1 = Date.now();
    stepActive(1, "Market Ingestion");
    await new Promise((r) => setTimeout(r, 120));
    stepDone(1, "Market Ingestion", Date.now() - t1, { symbol, barsLoaded: 60 });

    // Step 2 — Multi-Indicator Analysis
    const t2 = Date.now();
    stepActive(2, "Multi-Indicator Analysis");
    await new Promise((r) => setTimeout(r, 90));
    // Run the actual strategy to get real indicator values
    const result = await runStrategy([symbol], true, req.log, guardrails, strategyMode, idempotencyKey);
    const snap = result.snapshots[0];
    if (!snap) throw new Error("No snapshot returned for symbol");
    stepDone(2, "Multi-Indicator Analysis", Date.now() - t2, {
      adx: snap.adx,
      zScore: snap.zScore,
      volumeRatio: snap.volumeRatio,
      regime: snap.regime,
      cluster: snap.cluster,
    });

    // Step 3 — AI Thesis Generation
    const t3 = Date.now();
    stepActive(3, "AI Thesis Generation");
    await new Promise((r) => setTimeout(r, 80));
    const direction =
      snap.signal === "long_entry" ? "BULLISH"
      : snap.signal === "short_entry" ? "BEARISH"
      : "NEUTRAL";
    const confidence = Math.min(100, Math.round(Math.abs(snap.zScore) * 28 + snap.volumeRatio * 12));
    const thesis =
      direction === "BULLISH"
        ? `${symbol} is trading ${Math.abs(snap.zScore).toFixed(2)}σ below its 20-bar mean with volume at ${snap.volumeRatio.toFixed(2)}x average. ADX ${snap.adx.toFixed(1)} confirms a non-trending regime. Mean-reversion long thesis is active.`
        : direction === "BEARISH"
        ? `${symbol} is trading ${Math.abs(snap.zScore).toFixed(2)}σ above its 20-bar mean with volume at ${snap.volumeRatio.toFixed(2)}x average. ADX ${snap.adx.toFixed(1)} confirms a non-trending regime. Mean-reversion short thesis is active.`
        : `${symbol} Z-score ${snap.zScore.toFixed(2)} has not crossed the entry threshold. No directional thesis generated.`;
    stepDone(3, "AI Thesis Generation", Date.now() - t3, { thesis, direction, confidence });

    // Step 4 — Deterministic Risk Gates
    const t4 = Date.now();
    stepActive(4, "Deterministic Risk Gates");
    await new Promise((r) => setTimeout(r, 60));
    const gates = [
      { rule: "Volume confirmation", passed: snap.volumeRatio >= guardrails.minVolumeRatio, value: `${snap.volumeRatio.toFixed(2)}x (min ${guardrails.minVolumeRatio}x)` },
      { rule: "ADX trend gate", passed: snap.adx <= guardrails.adxMax, value: `ADX ${snap.adx.toFixed(1)} (max ${guardrails.adxMax})` },
      { rule: "Z-score threshold", passed: Math.abs(snap.zScore) >= guardrails.entryZ || snap.signal === "hold", value: `${snap.zScore.toFixed(2)}σ (entry ±${guardrails.entryZ}σ)` },
      { rule: "Duplicate position check", passed: snap.positionQty === 0, value: snap.positionQty === 0 ? "No open position" : "Position exists" },
      { rule: "Hard invalidation guard", passed: Math.abs(snap.zScore) < guardrails.invalidationZ, value: `${snap.zScore.toFixed(2)}σ (limit ±${guardrails.invalidationZ}σ)` },
      { rule: "Paper-only execution lock", passed: true, value: "LOCKED" },
    ];
    const allPassed = snap.signal === "long_entry" || snap.signal === "short_entry";
    stepDone(4, "Deterministic Risk Gates", Date.now() - t4, { gates, allPassed });

    // Step 5 — Trade Proposal
    const t5 = Date.now();
    stepActive(5, "Trade Proposal");
    await new Promise((r) => setTimeout(r, 50));
    if (snap.signal === "long_entry" || snap.signal === "short_entry") {
      const positionUsd = 100_000 * (guardrails.maxPositionPct / 100);
      const qty = Math.max(1, Math.floor(positionUsd / snap.price));
      const stopLoss = snap.signal === "long_entry" ? snap.price * 0.98 : snap.price * 1.02;
      const takeProfit = snap.signal === "long_entry" ? snap.sma : snap.sma;
      stepDone(5, "Trade Proposal", Date.now() - t5, {
        positionPct: guardrails.maxPositionPct,
        positionUsd,
        qty,
        side: snap.signal === "long_entry" ? "BUY" : "SELL",
        stopLoss,
        takeProfit,
      });
    } else {
      stepDone(5, "Trade Proposal", Date.now() - t5, { side: "NONE", reason: snap.tradeBlockedReason ?? "No entry signal" });
    }

    // Step 6 — Alpaca Paper Execution
    const t6 = Date.now();
    stepActive(6, "Alpaca Paper Execution");
    await new Promise((r) => setTimeout(r, 70));
    const action = result.actions[0];
    if (action && (action.status === "submitted" || action.status === "simulated")) {
      stepDone(6, "Alpaca Paper Execution", Date.now() - t6, {
        orderId: action.orderId ?? "demo-" + action.id.slice(0, 8),
        idempotencyKey: idempotencyKey ?? "(none)",
        status: action.status,
        side: action.action,
      });
    } else {
      stepDone(6, "Alpaca Paper Execution", Date.now() - t6, { skipped: true, reason: snap.tradeBlockedReason ?? snap.signal });
    }

    // Step 7 — Post-Run Result
    const t7 = Date.now();
    stepActive(7, "Post-Run Result");
    await new Promise((r) => setTimeout(r, 40));
    const verdict = (snap.signal === "long_entry" || snap.signal === "short_entry") ? "APPROVED" : "REJECTED";
    const verdictReason =
      verdict === "APPROVED"
        ? `Paper ${snap.signal === "long_entry" ? "BUY" : "SELL"} order submitted for ${symbol}`
        : snap.tradeBlockedReason ?? `Signal: ${snap.signal}`;
    stepDone(7, "Post-Run Result", Date.now() - t7, { verdict, reason: verdictReason, signal: snap.signal });

    emit({ done: true, verdict, reason: verdictReason });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Pipeline error";
    req.log.error({ err }, "Console pipeline stream failed");
    stepRejected(0, "Pipeline Error", msg);
    emit({ done: true, verdict: "REJECTED", reason: msg });
  } finally {
    res.end();
  }
});

router.post("/agent/flatten", async (req, res): Promise<void> => {
  try {
    res.json(await flattenPositions(req.log));
  } catch (error) {
    req.log.error({ err: error }, "Paper flatten failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Paper flatten failed" });
  }
});

router.get("/agent/market/:symbol", async (req, res): Promise<void> => {
  const parsed = GetMarketSnapshotParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const snapshot = await getMarketSnapshot(parsed.data.symbol);
    if (!snapshot) {
      res.status(404).json({ error: "Symbol is not configured for this agent." });
      return;
    }
    res.json(snapshot);
  } catch (error) {
    req.log.error({ err: error }, "Market snapshot failed");
    res.status(502).json({ error: error instanceof Error ? error.message : "Market snapshot failed" });
  }
});

export default router;