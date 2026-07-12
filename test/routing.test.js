import test from "node:test";
import assert from "node:assert/strict";
import { modelForRole } from "../src/routing.js";

test("routes scouting to benchmarked GPT-5.4 nano", () => {
  assert.equal(modelForRole("scout"), "azureai-textved/factory-gpt-5-4-nano");
});

test("routes independent testing to GPT-5.4", () => {
  assert.equal(modelForRole("tester"), "azureai-responses/gpt-5.4");
});

test("routes code generation to benchmarked Kimi K2.7-Code", () => {
  assert.equal(modelForRole("builder"), "azureai-textved/factory-kimi-k2-7-code");
});

test("routes engineering judgment roles to GPT-5.6", () => {
  for (const role of ["planner", "debugger", "reviewer", "security", "release"]) {
    assert.equal(modelForRole(role), "azureai-textved/gpt-5.6-sol");
  }
});

test("rejects unknown roles", () => {
  assert.throws(() => modelForRole("administrator"), /Unknown role/);
});
