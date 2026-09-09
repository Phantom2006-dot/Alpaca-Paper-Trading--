/**
 * Thin server-side client for the PowerX OpenAI-compatible API.
 *
 * The token is read at request time and is never exposed to the browser.
 * POWERX_API_URL may include the API version path (for example `/v1`).
 */

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type ChatMessage = { role: "system" | "user"; content: string | ContentPart[] };

type PowerXResponse = Record<string, unknown>;

type HttpResult = { body: unknown; headers: Headers };

const DEFAULT_API_URL = "https://http--powerx-app--cmttpj77q5vc.code.run/v1";
const DEFAULT_MODEL_NAME = "powerx-agent";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface AgentContext {
  mode?: string;
  equity?: number;
  cash?: number;
  positions?: Array<{ symbol: string; qty: number; side: string; unrealizedPnl: number }>;
  running?: boolean;
  symbols?: string[];
  lastRunAt?: string | null;
}

export interface PowerXOptions {
  text?: string;
  fileBytes?: Buffer;
  mimeType?: string;
  /** Poll an asynchronous PowerX response until it completes. Defaults to true. */
  poll?: boolean;
  agentContext?: AgentContext;
}

function envPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function apiUrl(): string {
  const configured = process.env["POWERX_API_URL"]?.trim() || DEFAULT_API_URL;
  return configured.replace(/\/+$/, "");
}

function endpointUrl(path: string): string {
  return `${apiUrl()}/${path.replace(/^\/+/, "")}`;
}

function buildSystemPrompt(ctx: AgentContext): string {
  const pos = ctx.positions?.length
    ? ctx.positions
        .map(
          (p) =>
            `  - ${p.symbol}: ${p.qty} shares ${p.side}, unrealized P&L $${p.unrealizedPnl.toFixed(2)}`,
        )
        .join("\n")
    : "  No open positions.";
  return `You are Kairo, an AI paper trading agent built on Alpaca Markets. You help users understand their paper portfolio and trading strategies. Always be concise and specific to the user's actual data below.

Current account state:
- Mode: ${ctx.mode ?? "unknown"} (paper trading only, no real money)
- Equity: $${ctx.equity?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "unknown"}
- Cash: $${ctx.cash?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "unknown"}
- Agent running: ${ctx.running ? `yes, scanning ${ctx.symbols?.join(", ") ?? ""}` : "no"}
- Last scan: ${ctx.lastRunAt ? new Date(ctx.lastRunAt).toLocaleTimeString() : "never"}

Open positions:
${pos}

Strategies available: Z-score mean-reversion (entry at |Z|≥2σ, ADX<25, volume≥1×) and ICT/HMM 5-cluster. All orders are paper only.`;
}

function buildPayload(opts: PowerXOptions): object {
  const parts: ContentPart[] = [];

  if (opts.text !== undefined) {
    parts.push({ type: "text", text: opts.text });
  }

  if (opts.fileBytes !== undefined && opts.mimeType !== undefined) {
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${opts.mimeType};base64,${opts.fileBytes.toString("base64")}`,
      },
    });
  }

  if (parts.length === 0) throw new Error("Provide text or file data.");

  const messages: ChatMessage[] = [];
  if (opts.agentContext) {
    messages.push({ role: "system", content: buildSystemPrompt(opts.agentContext) });
  }
  messages.push({ role: "user", content: parts });

  return {
    model: process.env["POWERX_MODEL"]?.trim() || DEFAULT_MODEL_NAME,
    messages,
  };
}

function truncate(value: string, maxLength = 500): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function isRecord(value: unknown): value is PowerXResponse {
  return typeof value === "object" && value !== null;
}

function statusOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const status = value["status"];
  return typeof status === "string" ? status.toLowerCase() : undefined;
}

function isProcessing(value: unknown): boolean {
  return ["processing", "queued", "pending", "in_progress"].includes(statusOf(value) ?? "");
}

function contentFrom(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const choices = value["choices"];
  if (Array.isArray(choices)) {
    const message = choices[0] && isRecord(choices[0]) ? choices[0]["message"] : undefined;
    if (isRecord(message)) {
      const content = message["content"];
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const text = content
          .filter((part): part is PowerXResponse => isRecord(part) && part["type"] === "text")
          .map((part) => part["text"])
          .filter((part): part is string => typeof part === "string")
          .join("");
        if (text) return text;
      }
    }
  }

  for (const key of ["result", "response", "data"]) {
    const nested = value[key];
    const content = contentFrom(nested);
    if (content !== null) return content;
  }

  const directContent = value["content"];
  return typeof directContent === "string" ? directContent : null;
}

function pollUrlFrom(value: unknown, headers: Headers): string | null {
  const location = headers.get("location");
  if (location) return location;
  if (!isRecord(value)) return null;

  for (const key of ["poll_url", "status_url", "result_url", "url"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function resolvePollUrl(candidate: string): string {
  const resolved = new URL(candidate, endpointUrl("chat/completions"));
  const configured = new URL(apiUrl());
  if (resolved.protocol !== "https:" && resolved.protocol !== "http:") {
    throw new Error("PowerX returned an invalid polling URL.");
  }
  if (resolved.origin !== configured.origin) {
    throw new Error("PowerX returned a polling URL on an unexpected origin.");
  }
  return resolved.toString();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function request(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await readJson(response);
    if (!response.ok) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      const suspended = /service suspended/i.test(detail);
      // Envoy/Cloud Run-style gateway errors: the PowerX app itself is not
      // serving (crashed, restarting, scaled to zero, or bad port). Relay an
      // actionable message instead of the cryptic proxy text.
      const upstreamDown =
        response.status >= 500 &&
        (/upstream connect error|connection termination|no healthy upstream|reset before headers/i.test(detail) ||
          detail === "");
      throw new Error(
        suspended
          ? "PowerX service is suspended. Configure a live PowerX deployment and rotate POWERX_API_TOKEN."
          : upstreamDown
            ? `PowerX service is unavailable (upstream ${response.status} from ${new URL(url).host}). The PowerX deployment is down or restarting — check its service health, then retry.`
            : `PowerX API ${response.status}: ${truncate(detail || response.statusText)}`,
      );
    }
    return { body, headers: response.headers };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`PowerX request timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function post(payload: object): Promise<HttpResult> {
  const token = process.env["POWERX_API_TOKEN"]?.trim();
  if (!token) throw new Error("POWERX_API_TOKEN is not configured on the API deployment.");

  return request(
    endpointUrl("chat/completions"),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    },
    envPositiveInteger("POWERX_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
  );
}

async function poll(url: string): Promise<HttpResult> {
  const token = process.env["POWERX_API_TOKEN"]?.trim();
  if (!token) throw new Error("POWERX_API_TOKEN is not configured on the API deployment.");

  return request(
    resolvePollUrl(url),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    },
    envPositiveInteger("POWERX_REQUEST_TIMEOUT_MS", DEFAULT_REQUEST_TIMEOUT_MS),
  );
}

export async function queryPowerX(opts: PowerXOptions): Promise<string> {
  const payload = buildPayload(opts);
  const shouldPoll = opts.poll !== false;
  const deadline = Date.now() + envPositiveInteger("POWERX_POLL_TIMEOUT_MS", DEFAULT_POLL_TIMEOUT_MS);
  let result = await post(payload);

  while (isProcessing(result.body)) {
    const provisional = contentFrom(result.body);
    if (!shouldPoll) {
      if (provisional !== null) return provisional;
      throw new Error("PowerX is still processing this request; enable polling for the final answer.");
    }

    const candidate = pollUrlFrom(result.body, result.headers);
    if (!candidate) {
      throw new Error("PowerX returned an asynchronous response without a polling URL.");
    }
    if (Date.now() >= deadline) throw new Error("PowerX polling timed out.");

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(envPositiveInteger("POWERX_POLL_INTERVAL_MS", DEFAULT_POLL_INTERVAL_MS), Math.max(0, deadline - Date.now()))),
    );
    result = await poll(candidate);
  }

  const content = contentFrom(result.body);
  if (content === null) {
    throw new Error(`Unexpected PowerX response: ${truncate(JSON.stringify(result.body))}`);
  }
  return content;
}
