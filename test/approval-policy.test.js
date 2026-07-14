import test from "node:test";
import assert from "node:assert/strict";
import { approvalPolicies, evaluateApprovalPolicy } from "../src/approval-policy.js";
import { ControlPlane } from "../src/control-plane.js";
import { parseApprovalDecisionMessage, parseApprovalRequestMessage } from "../src/validation.js";

const objective = {
  id: "objective1",
  type: "objective",
  objective: "Ship safely",
  repository: "https://github.com/acme/app.git",
  baseBranch: "main",
};

class LockedStore {
  constructor(value) { this.value = structuredClone(value); this.pending = Promise.resolve(); this.results = []; }
  async read() { return structuredClone(this.value); }
  async update(_id, operation) {
    const current = this.pending.then(async () => {
      const next = await operation(await this.read());
      await new Promise((resolve) => setImmediate(resolve));
      this.value = structuredClone(next);
      return structuredClone(next);
    });
    this.pending = current.catch(() => {});
    return current;
  }
  async writeResult(_id, result) { this.results.push(structuredClone(result)); }
}

const request = {
  type: "approval_request",
  objectiveId: objective.id,
  approvalId: "approval1",
  policy: "external_side_effects",
  reason: "Publishing changes outside the worktree",
  actor: "release-hook",
  requestedAt: "2026-07-13T10:00:00.000Z",
  expiresAt: "2026-07-13T11:00:00.000Z",
  checkpoint: "refs/factory/checkpoint-1",
};

function decision(value = {}) {
  return {
    type: "approval_decision",
    objectiveId: objective.id,
    approvalId: "approval1",
    decision: "approved",
    actor: "operator@example.com",
    reason: "Reviewed",
    decidedAt: "2026-07-13T10:30:00.000Z",
    messageId: "approval1-approved-operator",
    ...value,
  };
}

test("requires approval for every privileged change category", () => {
  assert.deepEqual(approvalPolicies, ["network_expansion", "new_dependencies", "infrastructure_changes", "secret_metadata_changes", "external_side_effects"]);
  for (const policy of approvalPolicies) {
    const result = evaluateApprovalPolicy({ [policy]: true });
    assert.equal(result.required, true);
    assert.deepEqual(result.policies, [policy]);
  }
  assert.deepEqual(evaluateApprovalPolicy({}), { required: false, policies: [] });
});

test("strictly validates durable approval request and decision messages", () => {
  assert.equal(parseApprovalRequestMessage(request).policy, "external_side_effects");
  assert.equal(parseApprovalDecisionMessage(decision()).decision, "approved");
  assert.throws(() => parseApprovalRequestMessage({ ...request, command: "deploy" }));
  assert.throws(() => parseApprovalDecisionMessage({ ...decision(), decision: "maybe" }));
  assert.throws(() => parseApprovalDecisionMessage({ ...decision(), messageId: undefined }));
});

test("persists approval requests and resumes from their checkpoint after approval", async () => {
  const store = new LockedStore({ objective, status: "running", tasks: [], results: {} });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });

  await control.acceptApprovalRequest(request);
  assert.equal((await store.read()).status, "approval_required");
  assert.deepEqual((await store.read()).approval, { ...request, status: "approval_required" });

  await control.acceptApprovalDecision(decision());
  const state = await store.read();
  assert.equal(state.status, "approved");
  assert.equal(state.approval.status, "approved");
  assert.equal(state.approval.actor, "operator@example.com");
  assert.equal(state.approval.checkpoint, "refs/factory/checkpoint-1");
  assert.equal(state.approval.messageId, "approval1-approved-operator");
});

test("redelivered approval decisions retry dispatch after a transient enqueue failure", async () => {
  const task = { id: "build000", role: "builder", title: "Build", instructions: "Implement", dependsOn: [], capabilities: [] };
  const store = new LockedStore({ objective, status: "approval_required", tasks: [task], results: { build000: { status: "approval_required" } }, approval: { ...request, checkpoint: "build000", status: "approval_required" } });
  let attempts = 0;
  const control = new ControlPlane({ store, registry: { defaults: {}, skills: {}, mcp: {} }, sendTask: async () => { attempts += 1; if (attempts === 1) throw new Error("queue unavailable"); } });
  const approved = decision();
  await assert.rejects(() => control.acceptApprovalDecision(approved), /queue unavailable/);
  assert.equal((await store.read()).status, "approved");
  await control.acceptApprovalDecision(approved);
  assert.equal(attempts, 2);
});

test("redelivered terminal approval decisions repair failed result writes", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  let writes = 0;
  store.writeResult = async () => { writes += 1; if (writes === 1) throw new Error("disk unavailable"); };
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  const denied = decision({ decision: "denied", messageId: "approval1-denied", reason: "Risk rejected" });
  await assert.rejects(() => control.acceptApprovalDecision(denied), /disk unavailable/);
  assert.equal((await store.read()).status, "denied");
  await control.acceptApprovalDecision(denied);
  assert.equal(writes, 2);
});

test("duplicate and conflicting decision messages are idempotent and monotonic", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  const approved = decision();

  await control.acceptApprovalDecision(approved);
  await control.acceptApprovalDecision(approved);
  await control.acceptApprovalDecision(decision({ decision: "denied", actor: "other", reason: "Too late", messageId: "approval1-denied-other" }));

  const state = await store.read();
  assert.equal(state.status, "approved");
  assert.equal(state.approval.status, "approved");
  assert.equal(state.approval.messageId, approved.messageId);
});

test("approval versus expiry race has one durable monotonic winner", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  const expiration = decision({ decision: "expired", actor: "approval-timeout", reason: "Approval window elapsed", decidedAt: request.expiresAt, messageId: "approval1-expired-timeout" });

  await Promise.all([control.acceptApprovalDecision(expiration), control.acceptApprovalDecision(decision())]);

  const winner = await store.read();
  assert.ok(["approved", "expired"].includes(winner.status));
  assert.equal(winner.approval.status, winner.status);
  const settled = structuredClone(winner);
  await control.acceptApprovalDecision(decision({ decision: "denied", messageId: "approval1-late-denial" }));
  assert.deepEqual(await store.read(), settled);
});

test("concurrent approval and denial decisions cannot overwrite each other", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });

  await Promise.all([
    control.acceptApprovalDecision(decision()),
    control.acceptApprovalDecision(decision({ decision: "denied", actor: "security@example.com", reason: "Risk rejected", messageId: "approval1-denied-security" })),
  ]);

  const winner = await store.read();
  assert.ok(["approved", "denied"].includes(winner.status));
  assert.equal(winner.approval.status, winner.status);
});

test("a late approval durably expires even without a timeout delivery", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });

  await control.acceptApprovalDecision(decision({ decidedAt: "2026-07-13T11:00:01.000Z", messageId: "approval1-late-approval" }));

  const state = await store.read();
  assert.equal(state.status, "expired");
  assert.equal(state.approval.status, "expired");
});

test("denial remains terminal against watchdog failure and late task results", async () => {
  const store = new LockedStore({ objective, status: "approval_required", tasks: [], results: {}, approval: { ...request, status: "approval_required" } });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  await control.acceptApprovalDecision(decision({ decision: "denied", messageId: "approval1-denied", reason: "Risk rejected" }));
  assert.equal(store.results.length, 1);

  await control.acceptFailure({ type: "failure_result", objectiveId: objective.id, taskId: "watchdog", error: "late" });
  await control.acceptTaskResult({
    type: "result",
    objectiveId: objective.id,
    taskId: "build",
    status: "succeeded",
    summary: "Late result",
    checks: [],
    risks: [],
    approval: "not_applicable",
    commit: "0123456789abcdef0123456789abcdef01234567",
    branch: "factory-ai/objective/build",
  });
  assert.equal((await store.read()).status, "denied");
  assert.deepEqual((await store.read()).results, {});
  assert.equal(store.results.length, 1);
});
