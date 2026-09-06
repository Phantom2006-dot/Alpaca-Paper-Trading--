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
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", healthRouter);

const localDemoAuth = process.env["ALLOW_LOCAL_DEV_AUTH"] === "true";
const authMiddleware = localDemoAuth ? (_req: Request, _res: Response, next: NextFunction) => next() : clerkMiddleware();

app.use("/api", authMiddleware, async (req, res, next) => {
  const userId = localDemoAuth ? "local-dev-user" : getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  try {
    await withUserCredentials(userId, next);
  } catch (error) {
    req.log.error({ err: error }, "Unable to load user credentials");
    res.status(503).json({ error: error instanceof Error ? error.message : "Credential storage is unavailable." });
  }
});
app.use("/api", agentRouter);

export default app;
