import { Router, type IRouter } from "express";

import {
  GetMarketSnapshotParams,
  OptimizeBacktestBody,
  RunBacktestBody,
  RunStrategyBody,
  GetAgentAssetsQueryParams,
  StartAgentBody,
  TestPaperRoundTripBody,
} from "@workspace/api-zod";

import {
  flattenPositions,
  guardrails,
  getAgentAccount,
  getAgentAssets,
  getDashboard,
  getMarketSnapshot,
  getStatus,
  optimizeBacktest,
  runBacktest,
  runStrategy,
  startAgent,
  stopAgent,
  testPaperRoundTrip,
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
  const parsed = StartAgentBody.safeParse(req.body ?? {});
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
        parsed.data.settings,
        req.log,
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Continuous agent start failed");
    res.status(409).json({
      error: error instanceof Error ? error.message : "Continuous agent could not start",
    });
  }
});

router.post("/agent/stop", async (req, res): Promise<void> => {
  try {
    res.json(await stopAgent(req.log));
  } catch (error) {
    req.log.error({ err: error }, "Continuous agent stop failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Continuous agent could not stop",
    });
  }
});

router.post("/agent/test-trade", async (req, res): Promise<void> => {
  const parsed = TestPaperRoundTripBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid paper round-trip input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(
      await testPaperRoundTrip(
        parsed.data.symbol,
        parsed.data.quantity,
        req.log,
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Paper round-trip test failed");
    res.status(409).json({
      error: error instanceof Error ? error.message : "Paper round-trip test failed",
    });
  }
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