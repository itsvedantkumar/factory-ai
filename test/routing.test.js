import test from "node:test";
import assert from "node:assert/strict";
import { modelForRole, modelForTask } from "../src/routing.js";

test("routes scouting to benchmarked GPT-5.4 nano", () => {
  assert.equal(modelForRole("scout"), "azureai-textved/factory-gpt-5-4-nano");
});

test("routes independent testing to GPT-5.4", () => {
  assert.equal(modelForRole("tester"), "azureai-responses/gpt-5.4");
});

test("routes builders to GPT-5.6 by default", () => {
  assert.equal(modelForRole("builder"), "azureai-textved/gpt-5.6-sol");
});

test("routes only explicitly simple builder tasks to Kimi", () => {
  assert.equal(modelForTask({ role: "builder", complexity: "simple" }), "azureai-textved/factory-kimi-k2-7-code");
  assert.equal(modelForTask({ role: "builder", complexity: "complex" }), "azureai-textved/gpt-5.6-sol");
  assert.equal(modelForTask({ role: "builder" }), "azureai-textved/gpt-5.6-sol");
});

test("routes engineering judgment roles to GPT-5.6", () => {
  for (const role of ["planner", "builder", "debugger", "reviewer", "security", "release"]) {
    assert.equal(modelForRole(role), "azureai-textved/gpt-5.6-sol");
  }
});

test("rejects unknown roles", () => {
  assert.throws(() => modelForRole("administrator"), /Unknown role/);
});
