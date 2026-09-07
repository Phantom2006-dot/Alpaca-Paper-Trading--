/**
 * powerx.ts
 * Thin client for the powerx-agent chat/completions endpoint.
 * Token is read from POWERX_API_TOKEN at call time — never hardcoded.
 */

const API_URL = "https://minis-yzdb.onrender.com/v1/chat/completions";
const MODEL_NAME = "powerx-agent";
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 30_000;

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatCompletionResponse {
  choices: [{ message: { content: string } }];
}

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
  poll?: boolean;
  agentContext?: AgentContext;
}

function buildSystemPrompt(ctx: AgentContext): string {
  const pos = ctx.positions?.length
    ? ctx.positions.map((p) => `  - ${p.symbol}: ${p.qty} shares ${p.side}, unrealized P&L $${p.unrealizedPnl.toFixed(2)}`).join("\n")
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
    const b64 = opts.fileBytes.toString("base64");
    parts.push({
      type: "image_url",
      image_url: { url: `data:${opts.mimeType};base64,${b64}` },
    });
  }

  if (parts.length === 0) throw new Error("Provide text or file data.");

  const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
  if (opts.agentContext) {
    messages.push({ role: "system", content: buildSystemPrompt(opts.agentContext) });
  }
  messages.push({ role: "user", content: parts });

  return { model: MODEL_NAME, messages };
}

async function post(payload: object): Promise<unknown> {
  const token = process.env["POWERX_API_TOKEN"];
  if (!token) throw new Error("POWERX_API_TOKEN environment variable is not set.");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`PowerX API ${res.status}: ${body}`);
  }

  return res.json();
}

function extractContent(resp: unknown): string {
  const r = resp as ChatCompletionResponse;
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Unexpected PowerX response: ${JSON.stringify(resp)}`);
  }
  return content;
}

export async function queryPowerX(opts: PowerXOptions): Promise<string> {
  const payload = buildPayload(opts);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (true) {
    const resp = await post(payload);

    if (
      typeof resp === "object" &&
      resp !== null &&
      "status" in resp &&
      (resp as Record<string, unknown>)["status"] === "processing"
    ) {
      if (!opts.poll) return extractContent(resp);
      if (Date.now() >= deadline) throw new Error("PowerX polling timed out.");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    return extractContent(resp);
  }
}
