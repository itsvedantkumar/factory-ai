import test from "node:test";
import assert from "node:assert/strict";
import { QuickActionControl } from "../src/quick-action-control.js";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async read(id) { if (!this.values.has(id)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; } return structuredClone(this.values.get(id)); }
  async write(id, value) { this.values.set(id, structuredClone(value)); return value; }
  async update(id, operation) { return this.write(id, await operation(await this.read(id))); }
}

const action = { id: "action-123", type: "quick_action", kind: "prompt", prompt: "Explain the router", workspace: "app", repository: "https://github.com/acme/app.git", baseBranch: "main", createdAt: "2026-07-15T00:00:00.000Z" };

test("quick actions dispatch one direct scout without creating an objective plan", async () => {
  const sent = [];
  const store = new MemoryStore();
  const control = new QuickActionControl({ store, sendTask: async (message) => sent.push(message) });
  await control.acceptAction(action);
  assert.equal((await store.read(action.id)).status, "queued");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "quick_action_task");
  assert.equal(sent[0].task.role, "scout");
});

test("quick action results become terminal and redelivery does not dispatch twice", async () => {
  const sent = [];
  const store = new MemoryStore();
  const control = new QuickActionControl({ store, sendTask: async (message) => sent.push(message) });
  await control.acceptAction(action);
  await control.acceptResult({ type: "quick_action_result", actionId: action.id, status: "succeeded", summary: "The router maps paths.", checks: [], risks: [], approval: "not_applicable" });
  await control.acceptAction(action);
  assert.equal(sent.length, 1);
  assert.equal((await store.read(action.id)).result.summary, "The router maps paths.");
});

test("quick action failures reject traversal identifiers", async () => {
  const control = new QuickActionControl({ store: new MemoryStore(), sendTask: async () => {} });
  await assert.rejects(() => control.acceptFailure({ type: "quick_action_failure", actionId: "../objective", error: "bad" }), /invalid|Action ID|String/i);
});

test("quick action transitions publish durable queued and terminal states", async () => {
  const published = [];
  const store = new MemoryStore();
  const control = new QuickActionControl({
    store,
    sendTask: async () => {},
    publish: async (state) => published.push(structuredClone(state)),
  });

  await control.acceptAction(action);
  await control.acceptResult({ type: "quick_action_result", actionId: action.id, status: "succeeded", summary: "Done", checks: [], risks: [], approval: "not_applicable" });

  assert.equal(published.length, 2);
  assert.equal(published[0].status, "queued");
  assert.ok(published[0].dispatchedAt);
  assert.equal(published[1].status, "succeeded");
  assert.equal(published[1].result.summary, "Done");
});

test("quick action failure is redacted before publication", async () => {
  const published = [];
  const store = new MemoryStore();
  const control = new QuickActionControl({ store, sendTask: async () => {}, publish: async (state) => published.push(state) });
  await control.acceptAction(action);
  await control.acceptFailure({ type: "quick_action_failure", actionId: action.id, error: "token=super-secret request failed" });
  assert.equal(published.at(-1).failure, "token=[REDACTED] request failed");
});
