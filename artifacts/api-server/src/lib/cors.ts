/**
 * Single source of truth for the browser origins this API may be called from.
 *
 * Used by:
 *  - the global `cors()` middleware in app.ts
 *  - the hand-rolled SSE headers in routes/agent.ts (Vercel streaming
 *    responses may not propagate middleware headers)
 *
 * Origins come from, in order of precedence:
 *  1. `CORS_ORIGINS`  — comma-separated list (preferred)
 *  2. `CORS_ORIGIN`   — single origin (legacy, still honoured)
 *  3. Built-in defaults for the known deployments
 *  4. Localhost dev origins when NODE_ENV !== "production"
 *
 * If the app is ever served from a new domain (e.g. a Vercel preview or a
 * custom domain), add it here via environment variables — no code change and
 * no redeploy of the API server needed.
 */

const DEFAULT_PROD_ORIGINS = [
  "https://kairo-trade-agent.vercel.app",
  "https://kairo-nu-two.vercel.app",
];

const DEFAULT_DEV_ORIGINS = [
  "http://localhost:24492",
  "http://127.0.0.1:24492",
];

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

export function getAllowedOrigins(): string[] {
  const configured = [
    process.env["CORS_ORIGINS"] ?? "",
    process.env["CORS_ORIGIN"] ?? "",
  ]
    .join(",")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const devOrigins = process.env["NODE_ENV"] !== "production" ? DEFAULT_DEV_ORIGINS : [];

  return [...new Set([...DEFAULT_PROD_ORIGINS, ...devOrigins, ...configured])];
}

export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return false;
  return getAllowedOrigins().includes(normalizeOrigin(origin));
}
