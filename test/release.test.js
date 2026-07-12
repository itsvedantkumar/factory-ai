import test from "node:test";
import assert from "node:assert/strict";
import { evaluateReleaseGate } from "../src/release.js";

const tasks = [
  { id: "test0000", role: "tester" },
  { id: "review00", role: "reviewer" },
  { id: "secure00", role: "security" },
];

test("opens release gate only for explicit tester, reviewer, and security approvals", () => {
  const approved = Object.fromEntries(tasks.map((task) => [task.id, {
    status: "succeeded",
    approval: "approved",
  }]));
  assert.deepEqual(evaluateReleaseGate(tasks, approved), { approved: true, blockers: [], autoMerge: false });

  approved.review00.approval = "changes_requested";
  assert.deepEqual(evaluateReleaseGate(tasks, approved), {
    approved: false,
    blockers: ["reviewer review00: changes_requested"],
    autoMerge: false,
  });
});

test("does not infer approval from task success", () => {
  const results = Object.fromEntries(tasks.map((task) => [task.id, { status: "succeeded" }]));
  assert.equal(evaluateReleaseGate(tasks, results).approved, false);
  assert.equal(evaluateReleaseGate(tasks, results).blockers.length, 3);
});

test("enables auto-merge only when repository policy allows it and required checks pass", () => {
  assert.equal(evaluateReleaseGate(tasks, {}, { approvals: false, policyAllows: true, checksPass: true }).autoMerge, false);
  assert.equal(evaluateReleaseGate(tasks, {}, { approvals: true, policyAllows: false, checksPass: true }).autoMerge, false);
  assert.equal(evaluateReleaseGate(tasks, {}, { approvals: true, policyAllows: true, checksPass: false }).autoMerge, false);
  assert.equal(evaluateReleaseGate(tasks, {}, { approvals: true, policyAllows: true, checksPass: true }).autoMerge, true);
});
