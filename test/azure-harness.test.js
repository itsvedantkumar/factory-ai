import test from "node:test";
import assert from "node:assert/strict";
import { AzureResponsesHarness } from "../src/azure-harness.js";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("continues a response after executing an allowlisted function", async () => {
  const requests = [];
  const fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) return response({
      id: "response-1",
      status: "completed",
      output: [{ type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"README.md"}' }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 20 } },
    });
    return response({
      id: "response-2",
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: '{"summary":"done"}' }] }],
      usage: { input_tokens: 40, output_tokens: 5, input_tokens_details: { cached_tokens: 30 } },
    });
  };
  const harness = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    fetch,
    maxOutputTokens: 777,
    tools: { read_file: { description: "Read", parameters: { type: "object" }, execute: async ({ path }) => `content:${path}` } },
  });

  const result = await harness.run("Inspect the repository");

  assert.equal(result.text, '{"summary":"done"}');
  assert.deepEqual(result.usage, { inputTokens: 140, cachedInputTokens: 50, outputTokens: 15 });
  assert.equal(requests[1].previous_response_id, "response-1");
  assert.equal(requests[0].max_output_tokens, 777);
  assert.equal(Object.hasOwn(requests[0].tools[0], "strict"), false);
  assert.deepEqual(requests[1].input, [{ type: "function_call_output", call_id: "call-1", output: "content:README.md" }]);
});

test("rejects model calls to tools outside the allowlist", async () => {
  const harness = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    fetch: async () => response({ id: "response-1", output: [{ type: "function_call", call_id: "call-1", name: "delete_everything", arguments: "{}" }] }),
    tools: {},
  });

  await assert.rejects(() => harness.run("Do work"), /Tool not allowed: delete_everything/);
});

test("retries transient HTTP failures but not authentication failures", async () => {
  let attempts = 0;
  const harness = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    retries: 2,
    sleep: async () => {},
    fetch: async () => {
      attempts += 1;
      if (attempts < 3) return response({ error: { code: "rate_limit" } }, 429);
      return response({ id: "response-3", output_text: "complete", output: [] });
    },
    tools: {},
  });
  assert.equal((await harness.run("Do work")).text, "complete");
  assert.equal(attempts, 3);

  const unauthorized = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    fetch: async () => response({ error: { code: "unauthorized" } }, 401),
    tools: {},
  });
  await assert.rejects(() => unauthorized.run("Do work"), /HTTP 401/);
});

test("enforces a bounded number of model steps", async () => {
  const harness = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    maxSteps: 2,
    fetch: async () => response({ id: "response-loop", output: [{ type: "function_call", call_id: "call-loop", name: "noop_tool", arguments: "{}" }] }),
    tools: { noop_tool: { description: "No-op", parameters: { type: "object" }, execute: async () => "ok" } },
  });
  await assert.rejects(() => harness.run("Loop"), /step limit/);
});

test("returns tool failures to the model so it can recover", async () => {
  const requests = [];
  const harness = new AzureResponsesHarness({
    baseUrl: "https://example.test/openai/v1",
    apiKey: "not-a-real-key",
    model: "gpt-test",
    fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      if (requests.length === 1) return response({ id: "r1", output: [{ type: "function_call", call_id: "c1", name: "test", arguments: "{}" }] });
      return response({ id: "r2", output_text: "recovered", output: [] });
    },
    tools: { test: { description: "test", parameters: { type: "object" }, execute: async () => { throw new Error("tests failed"); } } },
  });
  assert.equal((await harness.run("fix tests")).text, "recovered");
  assert.match(requests[1].input[0].output, /^ERROR: tests failed/);
});
