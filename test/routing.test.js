import test from "node:test";
import assert from "node:assert/strict";
import { modelForRole, modelForTask, validateModelRoute } from "../src/routing.js";

test("routes scouting to benchmarked GPT-5.4 nano", () => {
  assert.equal(modelForRole("scout"), "azureai-textved/factory-gpt-5-4-nano");
});

test("routes independent testing to GPT-5.4", () => {
  assert.equal(modelForRole("tester"), "azureai-textved/gpt-5.4");
});

test("routes builders to benchmarked GPT-5.5 by default", () => {
  assert.equal(modelForRole("builder"), "azureai-textved/gpt-5.5");
});

test("routes only explicitly simple builder tasks to Kimi", () => {
  assert.equal(modelForTask({ role: "builder", complexity: "simple" }), "azureai-textved/factory-kimi-k2-7-code");
  assert.equal(modelForTask({ role: "builder", complexity: "complex" }), "azureai-textved/gpt-5.5");
  assert.equal(modelForTask({ role: "builder" }), "azureai-textved/gpt-5.5");
});

test("routes engineering judgment roles to GPT-5.6", () => {
  for (const role of ["planner", "debugger", "reviewer", "security", "release"]) {
    assert.equal(modelForRole(role), "azureai-textved/gpt-5.6-sol");
  }
});

test("rejects unknown roles", () => {
  assert.throws(() => modelForRole("administrator"), /Unknown role/);
});

test("validates future model routes without hard-coding model names", () => {
  assert.equal(validateModelRoute("azureai-textved/gpt-6.1"), "azureai-textved/gpt-6.1");
  assert.equal(validateModelRoute("bedrock/global.anthropic.claude-next-v1:0"), "bedrock/global.anthropic.claude-next-v1:0");
  assert.throws(() => validateModelRoute("https://evil.test/model"), /Unsupported model provider/);
  assert.throws(() => validateModelRoute("azureai-textved/model name"), /Invalid model route/);
});
