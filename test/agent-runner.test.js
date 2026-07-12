import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AzureAgentRunner } from "../src/agent-runner.js";

test("routes each role to the correct Azure endpoint without OpenCode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-runner-"));
  const created = [];
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, {
    environment: {
      TEXTVED_AZURE_BASE_URL: "https://primary.test/openai/v1",
      TEXTVED_AZURE_API_KEY: "primary-key",
      AZURE_OPENAI_BASE_URL: "https://small.test/openai/v1",
      AZURE_OPENAI_API_KEY: "small-key",
    },
    createHarness: (options) => {
      created.push(options);
      return { run: async () => ({ text: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}' }) };
    },
  });
  const objective = { id: "objective1", objective: "Ship it" };

  await runner.invoke({ objective, task: { id: "scout001", role: "scout", instructions: "Inspect", capabilities: [] }, directory, prompt: "Work" });
  await runner.invoke({ objective, task: { id: "build001", role: "builder", instructions: "Build", capabilities: [] }, directory, prompt: "Work" });

  assert.equal(created[0].baseUrl, "https://small.test/openai/v1");
  assert.equal(created[0].model, "gpt-5.4");
  assert.equal(created[1].baseUrl, "https://primary.test/openai/v1");
  assert.equal(created[1].model, "gpt-5.6-sol");
  assert.ok(created.every((entry) => entry.tools.read_file && entry.tools.run_command));
});

test("fails closed when role credentials are unavailable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-runner-"));
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, { environment: {} });
  await assert.rejects(() => runner.invoke({
    objective: { id: "objective1", objective: "Ship" },
    task: { id: "build001", role: "builder", instructions: "Build", capabilities: [] },
    directory,
    prompt: "Work",
  }), /credentials are unavailable/);
});
