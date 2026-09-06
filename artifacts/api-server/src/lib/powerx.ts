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

export interface PowerXOptions {
  text?: string;
  fileBytes?: Buffer;
  mimeType?: string;
  poll?: boolean;
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

  return {
    model: MODEL_NAME,
    messages: [{ role: "user", content: parts }],
  };
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
