#!/usr/bin/env tsx
/**
 * query-powerx.ts
 *
 * Sends text, PDF, or ZIP data to the powerx-agent model and returns the
 * assistant reply. Polls for async results when requested.
 *
 * Run:  pnpm --filter @workspace/scripts run query-powerx
 * Env:  POWERX_API_TOKEN  (falls back to the default token if unset)
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const API_URL = `${(process.env["POWERX_API_URL"] ?? "https://http--powerx-app--cmttpj77q5vc.code.run/v1").replace(/\/+$/, "")}/chat/completions`;
const MODEL_NAME = process.env["POWERX_MODEL"] ?? "powerx-agent";
const POLL_INTERVAL_MS = Number(process.env["POWERX_POLL_INTERVAL_MS"] ?? 2_000);
const POLL_TIMEOUT_MS = Number(process.env["POWERX_POLL_TIMEOUT_MS"] ?? 30_000);

function getToken(): string {
  const token = process.env["POWERX_API_TOKEN"]?.trim();
  if (!token) throw new Error("POWERX_API_TOKEN must be set before running this script.");
  return token;
}

// ─── Types ────────────────────────────────────────────────────────────────────

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface ChatPayload {
  model: string;
  messages: [{ role: "user"; content: ContentPart[] }];
}

interface ChatCompletionResponse {
  choices: [{ message: { content: string } }];
}

interface AsyncProcessingResponse {
  status: "processing";
  poll_url?: string;
  status_url?: string;
  result_url?: string;
  url?: string;
  [key: string]: unknown;
}

type ApiResponse = ChatCompletionResponse | AsyncProcessingResponse;

export interface QueryOptions {
  /** Plain-text prompt. */
  text?: string;
  /** Raw file bytes (PDF, ZIP, etc.). */
  fileBytes?: Uint8Array | Buffer;
  /** MIME type matching fileBytes, e.g. "application/pdf". */
  mimeType?: string;
  /** Poll until a final answer arrives (default: false). */
  poll?: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildPayload(opts: QueryOptions): ChatPayload {
  const parts: ContentPart[] = [];

  if (opts.text !== undefined) {
    parts.push({ type: "text", text: opts.text });
  }

  if (opts.fileBytes !== undefined && opts.mimeType !== undefined) {
    const b64 = Buffer.from(opts.fileBytes).toString("base64");
    parts.push({
      type: "image_url",
      image_url: { url: `data:${opts.mimeType};base64,${b64}` },
    });
  }

  if (parts.length === 0) {
    throw new Error("You must supply either text or file data.");
  }

  return {
    model: MODEL_NAME,
    messages: [{ role: "user", content: parts }],
  };
}

async function sendRequest(payload: ChatPayload): Promise<{ response: ApiResponse; headers: Headers }> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      "User-Agent": "PowerX-Query-Script/1.0",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status} ${response.statusText}: ${body.slice(0, 500)}`);
  }

  return { response: (await response.json()) as ApiResponse, headers: response.headers };
}

function getPollUrl(resp: AsyncProcessingResponse, headers: Headers): string | null {
  return headers.get("location") ?? resp.poll_url ?? resp.status_url ?? resp.result_url ?? resp.url ?? null;
}

async function getPollResult(url: string): Promise<ApiResponse> {
  const parsed = new URL(url, API_URL);
  const configured = new URL(API_URL);
  if (parsed.origin !== configured.origin) throw new Error("PowerX returned an unexpected polling origin.");
  const response = await fetch(parsed, {
    headers: { Accept: "application/json", Authorization: `Bearer ${getToken()}` },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 500)}`);
  return response.json() as Promise<ApiResponse>;
}

function extractAssistantMessage(resp: ApiResponse): string {
  if ("status" in resp && resp.status === "processing") {
    throw new Error("Response is still processing — use poll: true.");
  }
  const completion = resp as ChatCompletionResponse;
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error(`Unexpected response format: ${JSON.stringify(resp)}`);
  }
  return content;
}
export async function queryPowerX(opts: QueryOptions): Promise<string> {
  const payload = buildPayload(opts);
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  let result = await sendRequest(payload);

  while ("status" in result.response && result.response.status === "processing") {
    if (!opts.poll) return extractAssistantMessage(result.response);
    const pollUrl = getPollUrl(result.response, result.headers);
    if (!pollUrl) throw new Error("PowerX returned an asynchronous response without a polling URL.");
    if (Date.now() >= deadline) throw new Error("Polling timed out waiting for final answer.");
    await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now()))));
    result = { response: await getPollResult(pollUrl), headers: new Headers() };
  }

  return extractAssistantMessage(result.response);
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // 1. Pure text query
  console.log("=== TEXT ===");
  console.log(await queryPowerX({ text: "What is 2+2?" }));

  // 2. PDF query
  const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF");
  console.log("\n=== PDF (empty) ===");
  console.log(
    await queryPowerX({
      fileBytes: pdfBytes,
      mimeType: "application/pdf",
      text: "What is in this PDF?",
    }),
  );

  // 3. ZIP query — build a minimal ZIP in memory
  // Node 24 does not have a built-in ZIP API, so we construct the smallest
  // valid local-file-header + end-of-central-directory manually.
  const fileName = "hello.txt";
  const fileContent = Buffer.from("Hello World from ZIP!");
  const fileNameBuf = Buffer.from(fileName);

  // Local file header (no compression, store only)
  const localHeader = Buffer.alloc(30 + fileNameBuf.length + fileContent.length);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4);          // version needed
  localHeader.writeUInt16LE(0, 6);           // flags
  localHeader.writeUInt16LE(0, 8);           // compression: store
  localHeader.writeUInt16LE(0, 10);          // mod time
  localHeader.writeUInt16LE(0, 12);          // mod date
  localHeader.writeUInt32LE(0, 14);          // crc-32 (omitted for demo)
  localHeader.writeUInt32LE(fileContent.length, 18); // compressed size
  localHeader.writeUInt32LE(fileContent.length, 22); // uncompressed size
  localHeader.writeUInt16LE(fileNameBuf.length, 26); // file name length
  localHeader.writeUInt16LE(0, 28);          // extra field length
  fileNameBuf.copy(localHeader, 30);
  fileContent.copy(localHeader, 30 + fileNameBuf.length);

  // Central directory + end record
  const centralDir = Buffer.alloc(46 + fileNameBuf.length);
  centralDir.writeUInt32LE(0x02014b50, 0);   // central dir signature
  centralDir.writeUInt16LE(20, 4);
  centralDir.writeUInt16LE(20, 6);
  centralDir.writeUInt16LE(0, 8);
  centralDir.writeUInt16LE(0, 10);
  centralDir.writeUInt16LE(0, 12);
  centralDir.writeUInt16LE(0, 14);
  centralDir.writeUInt32LE(0, 16);
  centralDir.writeUInt32LE(fileContent.length, 20);
  centralDir.writeUInt32LE(fileContent.length, 24);
  centralDir.writeUInt16LE(fileNameBuf.length, 28);
  centralDir.writeUInt16LE(0, 30);
  centralDir.writeUInt16LE(0, 32);
  centralDir.writeUInt16LE(0, 34);
  centralDir.writeUInt16LE(0, 36);
  centralDir.writeUInt32LE(0, 38);
  centralDir.writeUInt32LE(0, 42);
  fileNameBuf.copy(centralDir, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localHeader.length, 16);
  eocd.writeUInt16LE(0, 20);

  const zipBytes = Buffer.concat([localHeader, centralDir, eocd]);

  console.log("\n=== ZIP ===");
  console.log(
    await queryPowerX({
      fileBytes: zipBytes,
      mimeType: "application/zip",
      text: "List the contents of this ZIP file.",
    }),
  );

  // 4. Polling example
  // console.log("\n=== POLLING ===");
  // console.log(
  //   await queryPowerX({
  //     text: "Explain the theory of relativity in two sentences.",
  //     poll: true,
  //   }),
  // );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
