import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
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

  assert.equal(created[0].baseUrl, "https://primary.test/openai/v1");
  assert.equal(created[0].model, "factory-gpt-5-4-nano");
  assert.equal(created[1].baseUrl, "https://primary.test/openai/v1");
  assert.equal(created[1].model, "gpt-5.6-sol");
  assert.ok(created.every((entry) => entry.tools.read_file && entry.tools.run_command));
});

test("planner always receives goal and autonomous-loop skills", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-planner-"));
  const skill = path.join(directory, "goal.md");
  await writeFile(skill, "GOAL_RUBRIC_REQUIRED");
  let prompt;
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, {
    defaults: { planner: ["goal-management"] },
    skills: { "goal-management": { version: "1.0.0", path: skill, roles: ["planner"] } },
    mcp: {},
  }, {
    environment: { TEXTVED_AZURE_BASE_URL: "https://primary.test/openai/v1", TEXTVED_AZURE_API_KEY: "key" },
    createHarness: () => ({ run: async (value) => { prompt = value; return { text: '{"tasks":[]}' }; } }),
  });
  await runner.plan({ id: "objective1", objective: "/goal ship safely" }, directory);
  assert.match(prompt, /GOAL_RUBRIC_REQUIRED/);
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

test("supports Bedrock role overrides through the same agent contract", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-bedrock-runner-"));
  let options;
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, {
    environment: { FACTORY_MODEL_BUILDER: "bedrock/us.anthropic.claude-sonnet-4-6-v1:0", AWS_REGION: "us-east-1" },
    createBedrockHarness: (value) => { options = value; return { run: async () => ({ text: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}' }) }; },
  });
  await runner.invoke({ objective: { id: "o", objective: "Ship" }, task: { id: "b", role: "builder", instructions: "Build", capabilities: [] }, directory, prompt: "Work" });
  assert.equal(options.model, "us.anthropic.claude-sonnet-4-6-v1:0");
  assert.equal(options.region, "us-east-1");
});
