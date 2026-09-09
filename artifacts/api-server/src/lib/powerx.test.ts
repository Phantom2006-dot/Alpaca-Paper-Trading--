import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { queryPowerX } from "./powerx";

const originalFetch = globalThis.fetch;
const originalEnv = {
  token: process.env["POWERX_API_TOKEN"],
  url: process.env["POWERX_API_URL"],
  interval: process.env["POWERX_POLL_INTERVAL_MS"],
  timeout: process.env["POWERX_POLL_TIMEOUT_MS"],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of [
    ["POWERX_API_TOKEN", originalEnv.token],
    ["POWERX_API_URL", originalEnv.url],
    ["POWERX_POLL_INTERVAL_MS", originalEnv.interval],
    ["POWERX_POLL_TIMEOUT_MS", originalEnv.timeout],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("queryPowerX uses the replacement endpoint and returns synchronous content", async () => {
  process.env["POWERX_API_TOKEN"] = "test-token";
  process.env["POWERX_API_URL"] = "https://http--powerx-app--cmttpj77q5vc.code.run/v1";

  const requests: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init: init ?? {} });
    return jsonResponse({ choices: [{ message: { content: "paper response" } }] });
  };

  assert.equal(await queryPowerX({ text: "hello" }), "paper response");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://http--powerx-app--cmttpj77q5vc.code.run/v1/chat/completions");
  assert.equal(requests[0].init.method, "POST");
  assert.equal((requests[0].init.headers as Record<string, string>).Authorization, "Bearer test-token");
});

test("queryPowerX polls the returned status URL without repeating the POST", async () => {
  process.env["POWERX_API_TOKEN"] = "test-token";
  process.env["POWERX_POLL_INTERVAL_MS"] = "1";
  process.env["POWERX_POLL_TIMEOUT_MS"] = "1000";

  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "POST") {
      return jsonResponse({ status: "processing", status_url: "/v1/jobs/job-1" });
    }
    return jsonResponse({ choices: [{ message: { content: "final response" } }] });
  };

  assert.equal(await queryPowerX({ text: "hello" }), "final response");
  assert.deepEqual(requests, [
    "POST https://http--powerx-app--cmttpj77q5vc.code.run/v1/chat/completions",
    "GET https://http--powerx-app--cmttpj77q5vc.code.run/v1/jobs/job-1",
  ]);
});

test("queryPowerX rejects asynchronous responses without a polling URL", async () => {
  process.env["POWERX_API_TOKEN"] = "test-token";
  globalThis.fetch = async () => jsonResponse({ status: "processing" });

  await assert.rejects(
    queryPowerX({ text: "hello" }),
    /without a polling URL/,
  );
});

test("queryPowerX never sends a request without the server token", async () => {
  delete process.env["POWERX_API_TOKEN"];
  await assert.rejects(queryPowerX({ text: "hello" }), /POWERX_API_TOKEN/);
});
