import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware, getAuth } from "@clerk/express";
import healthRouter from "./routes/health";
import agentRouter from "./routes/agent";
import { withUserCredentials } from "./lib/strategy";
import { logger } from "./lib/logger";
import { getAllowedOrigins } from "./lib/cors";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Origin allowlist is centralized and env-driven — see src/lib/cors.ts.
app.use(cors({ origin: getAllowedOrigins(), credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);
const localDemoAuth = process.env["ALLOW_LOCAL_DEV_AUTH"] === "true";
const authMiddleware = localDemoAuth ? (_req: Request, _res: Response, next: NextFunction) => next() : clerkMiddleware();

if (!localDemoAuth && !process.env.CLERK_SECRET_KEY) {
  app.use("/api", (_req, res) => {
    res.status(503).json({ error: "API authentication is not configured. Set CLERK_SECRET_KEY on the API deployment." });
  });
} else {
  // Credentials route runs before withUserCredentials — it is the route that sets them.
  app.use("/api", authMiddleware, async (req, res, next) => {
    const userId = localDemoAuth ? "local-dev-user" : getAuth(req).userId;
    if (!userId) {
      res.status(401).json({ error: "Authentication required." });
      return;
    }
    // OPTIONS preflights must pass through immediately — no credential loading.
    if (req.method === "OPTIONS") { next(); return; }
    // /agent/credentials (GET/POST/DELETE) manages the credential store itself
    // — only resolve the user id, never load credentials here.
    if (req.path === "/agent/credentials") {
      (req as Request & { resolvedUserId?: string }).resolvedUserId = userId;
      next();
      return;
    }
    // All other routes — including /agent/status and /agent/console/stream —
    // attempt to load credentials from the DB so the user's saved keys are
    // available on every request after login, without requiring a manual re-entry.
    // withUserCredentials falls back to demo mode gracefully if none are found.
    try {
      await withUserCredentials(userId, next);
    } catch (error) {
      req.log.error({ err: error }, "Unable to load user credentials");
      res.status(503).json({ error: error instanceof Error ? error.message : "Credential storage is unavailable." });
    }
  });
}
app.use("/api", agentRouter);

// Catch-all error handler — always return JSON, never HTML
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : "Internal server error";
  res.status(500).json({ error: message });
});

export default app;
