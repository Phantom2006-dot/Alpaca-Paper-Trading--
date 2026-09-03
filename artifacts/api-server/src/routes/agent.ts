import { Router, type IRouter } from "express";

import {
  GetMarketSnapshotParams,
  RunBacktestBody,
  RunStrategyBody,
} from "@workspace/api-zod";

import {
  flattenPositions,
  getDashboard,
  getMarketSnapshot,
  getStatus,
  runBacktest,
  runStrategy,
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

router.post("/agent/run", async (req, res): Promise<void> => {
  const parsed = RunStrategyBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid strategy run input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    res.json(await runStrategy(parsed.data.symbols, parsed.data.dryRun, req.log));
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
      ),
    );
  } catch (error) {
    req.log.error({ err: error }, "Historical backtest failed");
    res.status(502).json({
      error: error instanceof Error ? error.message : "Historical backtest failed",
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