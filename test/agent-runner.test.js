import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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
  assert.equal(created[0].maxSteps, 14);
  assert.equal(created[0].maxOutputTokens, 1200);
  assert.equal(created[0].tools.write_file, undefined);
  assert.equal(created[1].baseUrl, "https://primary.test/openai/v1");
  assert.equal(created[1].model, "gpt-5.5");
  assert.equal(created[1].maxSteps, 32);
  assert.equal(created[1].maxOutputTokens, 3200);
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

test("injects repository AGENTS.md instructions into worker prompts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-instructions-"));
  await writeFile(path.join(directory, "AGENTS.md"), "RUN_THE_PROJECT_GATE");
  let prompt;
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, {
    environment: { TEXTVED_AZURE_BASE_URL: "https://primary.test/openai/v1", TEXTVED_AZURE_API_KEY: "key" },
    createHarness: () => ({ run: async (value) => { prompt = value; return { text: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}' }; } }),
  });

  await runner.invoke({ objective: { id: "o", objective: "Ship" }, task: { id: "b", role: "builder", instructions: "Build", capabilities: [] }, directory, prompt: "Work" });

  assert.match(prompt, /REPOSITORY INSTRUCTIONS AGENTS\.md/);
  assert.match(prompt, /RUN_THE_PROJECT_GATE/);
});

test("does not follow symbolic-link repository instructions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-instructions-"));
  const secret = path.join(directory, "..", `factory-secret-${process.pid}`);
  await writeFile(secret, "LOCAL_SECRET_MUST_NOT_LEAK");
  await symlink(secret, path.join(directory, "AGENTS.md"));
  let prompt;
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, {
    environment: { TEXTVED_AZURE_BASE_URL: "https://primary.test/openai/v1", TEXTVED_AZURE_API_KEY: "key" },
    createHarness: () => ({ run: async (value) => { prompt = value; return { text: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}' }; } }),
  });
  await runner.invoke({ objective: { id: "o", objective: "Ship" }, task: { id: "b", role: "builder", instructions: "Build", capabilities: [] }, directory, prompt: "Work" });
  assert.doesNotMatch(prompt, /LOCAL_SECRET_MUST_NOT_LEAK/);
});

test("discovers nested AGENTS.md and preconfigured project context", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-instructions-"));
  await mkdir(path.join(directory, "src", "billing"), { recursive: true });
  await mkdir(path.join(directory, ".agent-factory"));
  await writeFile(path.join(directory, "AGENTS.md"), "ROOT_POLICY");
  await writeFile(path.join(directory, "src", "billing", "AGENTS.md"), "BILLING_POLICY");
  await writeFile(path.join(directory, ".agent-factory", "commands.md"), "npm run verify");
  let prompt;
  const runner = new AzureAgentRunner({ timeoutMs: 60_000 }, { defaults: {}, skills: {}, mcp: {} }, {
    environment: { TEXTVED_AZURE_BASE_URL: "https://primary.test/openai/v1", TEXTVED_AZURE_API_KEY: "key" },
    createHarness: () => ({ run: async (value) => { prompt = value; return { text: '{"tasks":[]}' }; } }),
  });
  await runner.plan({ id: "objective1", objective: "Ship" }, directory);
  assert.match(prompt, /ROOT_POLICY/);
  assert.match(prompt, /src\/billing\/AGENTS\.md/);
  assert.match(prompt, /BILLING_POLICY/);
  assert.match(prompt, /npm run verify/);
});
