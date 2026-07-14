import test from "node:test";
import assert from "node:assert/strict";
import { findExpiredApprovals, findStaleAgents } from "../src/watchdog.js";

test("watchdog selects only queued agents with expired heartbeats", () => {
  const states = [{
    status: "running",
    objective: { id: "objective1" },
    tasks: [{ id: "build", role: "builder" }, { id: "done", role: "tester" }],
    results: { build: { status: "queued" }, done: { status: "succeeded" } },
    activity: { build: { occurredAt: "2026-01-01T00:00:00.000Z" }, done: { occurredAt: "2026-01-01T00:00:00.000Z" } },
  }];
  assert.deepEqual(findStaleAgents(states, new Date("2026-01-01T00:20:00.000Z"), 900), [{ objectiveId: "objective1", taskId: "build", role: "builder", occurredAt: "2026-01-01T00:00:00.000Z" }]);
});

test("watchdog ignores terminal objectives", () => {
  assert.deepEqual(findStaleAgents([{ status: "failed", objective: { id: "o" }, tasks: [{ id: "x", role: "builder" }], results: { x: { status: "queued" } }, activity: { x: { occurredAt: "2020-01-01T00:00:00.000Z" } } }]), []);
});

test("watchdog emits one deterministic expiration decision for unattended approvals", () => {
  const state = { status: "approval_required", objective: { id: "objective1" }, approval: { approvalId: "approval1", status: "approval_required", expiresAt: "2026-01-01T00:10:00.000Z" } };
  const decisions = findExpiredApprovals([state], new Date("2026-01-01T00:20:00.000Z"));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].decision, "expired");
  assert.equal(decisions[0].objectiveId, "objective1");
  assert.deepEqual(findExpiredApprovals([state], new Date("2026-01-01T00:05:00.000Z")), []);
});
