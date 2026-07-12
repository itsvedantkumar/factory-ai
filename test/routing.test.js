import test from "node:test";
import assert from "node:assert/strict";
import { modelForRole } from "../src/routing.js";

test("routes lightweight roles to GPT-5.4", () => {
  for (const role of ["scout", "tester"]) {
    assert.equal(modelForRole(role), "azureai-responses/gpt-5.4");
  }
});

test("routes engineering judgment roles to GPT-5.6", () => {
  for (const role of ["planner", "builder", "debugger", "reviewer", "security", "release"]) {
    assert.equal(modelForRole(role), "azureai-textved/gpt-5.6-sol");
  }
});

test("rejects unknown roles", () => {
  assert.throws(() => modelForRole("administrator"), /Unknown role/);
});
