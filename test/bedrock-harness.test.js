import test from "node:test";
import assert from "node:assert/strict";
import { BedrockHarness } from "../src/bedrock-harness.js";

test("continues Bedrock Converse after executing an allowlisted tool", async () => {
  const requests = [];
  const client = { send: async (command) => {
    requests.push(command.input);
    if (requests.length === 1) return { output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "call-1", name: "read_file", input: { path: "README.md" } } }] } }, stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 5 } };
    return { output: { message: { role: "assistant", content: [{ text: '{"summary":"done"}' }] } }, stopReason: "end_turn", usage: { inputTokens: 6, outputTokens: 4 } };
  } };
  const harness = new BedrockHarness({
    client,
    model: "model-id",
    maxOutputTokens: 777,
    tools: { read_file: { description: "Read", parameters: { type: "object" }, execute: async ({ path }) => `content:${path}` } },
  });
  const result = await harness.run("Inspect");
  assert.equal(result.text, '{"summary":"done"}');
  assert.equal(result.steps, 2);
  assert.equal(requests[0].inferenceConfig.maxTokens, 777);
  assert.equal(requests[1].messages[2].content[0].toolResult.toolUseId, "call-1");
  assert.equal(requests[1].messages[2].content[0].toolResult.content[0].text, "content:README.md");
});

test("rejects Bedrock calls to unknown tools", async () => {
  const harness = new BedrockHarness({
    client: { send: async () => ({ output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "x", name: "root_shell", input: {} } }] } } }) },
    model: "model-id",
    tools: {},
  });
  await assert.rejects(() => harness.run("work"), /Tool not allowed/);
});

test("automatically compacts oversized Bedrock conversation history", async () => {
  const requests = [];
  const events = [];
  const harness = new BedrockHarness({
    client: { send: async (command) => {
      requests.push(command.input);
      if (requests.length === 1) return { usage: { inputTokens: 60 }, output: { message: { role: "assistant", content: [{ toolUse: { toolUseId: "x", name: "read_file", input: {} } }] } } };
      return { output: { message: { role: "assistant", content: [{ text: "done" }] } } };
    } },
    model: "model-id",
    compactAfterInputTokens: 50,
    onEvent: (event) => events.push(event),
    tools: { read_file: { description: "read", parameters: { type: "object" }, execute: async () => "important evidence" } },
  });

  await harness.run("Original objective");

  assert.equal(requests[1].messages.length, 1);
  assert.match(requests[1].messages[0].content[0].text, /COMPACTED EXECUTION CHECKPOINT/);
  assert.equal(events.some((event) => event.type === "context.compacted"), true);
});
