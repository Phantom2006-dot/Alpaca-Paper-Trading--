import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware, getAuth } from "@clerk/express";
import healthRouter from "./routes/health";
import agentRouter from "./routes/agent";
import { withUserCredentials } from "./lib/strategy";
import { logger } from "./lib/logger";

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
app.use(cors({
  origin: [
    "https://kairo-trade-agent.vercel.app",
    "https://kairo-nu-two.vercel.app",
    ...(process.env["CORS_ORIGIN"] ? [process.env["CORS_ORIGIN"]] : []),
    ...(process.env["NODE_ENV"] !== "production" ? ["http://localhost:24492", "http://127.0.0.1:24492"] : []),
  ],
  credentials: true,
}));
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
    // Skip withUserCredentials for the credentials route itself.
    if (req.path === "/agent/credentials") {
      (req as Request & { resolvedUserId?: string }).resolvedUserId = userId;
      next();
      return;
    }
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
