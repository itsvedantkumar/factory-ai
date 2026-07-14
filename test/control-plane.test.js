import test from "node:test";
import assert from "node:assert/strict";
import { ControlPlane } from "../src/control-plane.js";

class MemoryStore {
  constructor() { this.values = new Map(); }
  async read(id) { if (!this.values.has(id)) { const error = new Error("missing"); error.code = "ENOENT"; throw error; } return structuredClone(this.values.get(id)); }
  async write(id, value) { this.values.set(id, structuredClone(value)); return value; }
  async update(id, operation) { return this.write(id, await operation(await this.read(id))); }
}

const objective = {
  id: "objective1",
  type: "objective",
  objective: "Ship safely",
  repository: "https://github.com/acme/app.git",
  baseBranch: "main",
};

test("accepting an objective only dispatches a planner subagent", async () => {
  const sent = [];
  const control = new ControlPlane({ store: new MemoryStore(), registry: {}, sendTask: async (message) => sent.push(message) });
  await control.acceptObjective(objective);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "planning_task");
  assert.equal(sent[0].task.role, "planner");
});

test("redelivered objectives retry planner dispatch after a transient enqueue failure", async () => {
  const store = new MemoryStore();
  let attempts = 0;
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => { attempts += 1; if (attempts === 1) throw new Error("queue unavailable"); } });
  await assert.rejects(() => control.acceptObjective(objective), /queue unavailable/);
  assert.equal((await store.read(objective.id)).status, "planning");
  await control.acceptObjective(objective);
  assert.equal(attempts, 2);
});

test("validated planning results dispatch ready task packets", async () => {
  const sent = [];
  const store = new MemoryStore();
  const control = new ControlPlane({ store, registry: { defaults: {}, skills: {}, mcp: {} }, sendTask: async (message) => sent.push(message) });
  await control.acceptObjective(objective);
  sent.length = 0;
  await control.acceptPlanningResult({
    type: "planning_result",
    objectiveId: objective.id,
    delivery: {
      executiveIntent: "ship",
      tasks: [
        { id: "build000", role: "builder", title: "Build", instructions: "Implement", dependsOn: [], capabilities: [] },
        { id: "test0000", role: "tester", title: "Test", instructions: "Test it", dependsOn: ["build000"], capabilities: [] },
        { id: "review00", role: "reviewer", title: "Review", instructions: "Review it", dependsOn: ["build000"], capabilities: [] },
        { id: "secure00", role: "security", title: "Secure", instructions: "Audit it", dependsOn: ["build000"], capabilities: [] },
        { id: "release0", role: "release", title: "Release", instructions: "Approve release", dependsOn: ["test0000", "review00", "secure00"], capabilities: [] },
      ],
    },
  });
  assert.deepEqual(sent.map((message) => message.task.id), ["build000"]);
  assert.equal(sent[0].type, "agent_task");
  assert.equal(sent[0].objective.objective, "Ship safely");
});

test("records permanent worker failures instead of leaving objectives queued", async () => {
  const store = new MemoryStore();
  store.writeResult = async (id, result) => { store.result = { id, result }; };
  await store.write(objective.id, { objective, status: "running", tasks: [], results: {} });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  await control.acceptFailure({ type: "failure_result", objectiveId: objective.id, taskId: "test", error: "content_filter" });
  assert.equal((await store.read(objective.id)).status, "failed");
  assert.equal(store.result.result.blockers[0], "test: content_filter");
});

test("late queue messages cannot overwrite terminal objective state", async () => {
  const store = new MemoryStore();
  store.writeResult = async () => { throw new Error("terminal result must not be rewritten"); };
  await store.write(objective.id, { objective, status: "complete", tasks: [], results: {}, release: { url: "https://github.com/acme/app/pull/1" } });
  const control = new ControlPlane({ store, registry: { defaults: {}, skills: {}, mcp: {} }, sendTask: async () => {} });
  await control.acceptFailure({ type: "failure_result", objectiveId: objective.id, taskId: "build", error: "late watchdog" });
  assert.equal((await store.read(objective.id)).status, "complete");

  await store.write(objective.id, { objective, status: "failed", tasks: [], results: {} });
  await control.acceptReleaseResult({ type: "release_result", objectiveId: objective.id, release: { url: "https://github.com/acme/app/pull/2" } });
  assert.equal((await store.read(objective.id)).status, "failed");
});

test("terminal result redelivery repairs failed durable result writes", async () => {
  const store = new MemoryStore();
  let writes = 0;
  store.writeResult = async () => { writes += 1; if (writes === 1) throw new Error("disk unavailable"); };
  await store.write(objective.id, { objective, status: "running", tasks: [], results: {} });
  const control = new ControlPlane({ store, registry: {}, sendTask: async () => {} });
  const release = { type: "release_result", objectiveId: objective.id, release: { url: "https://github.com/acme/app/pull/1" } };
  await assert.rejects(() => control.acceptReleaseResult(release), /disk unavailable/);
  assert.equal((await store.read(objective.id)).status, "complete");
  await control.acceptReleaseResult(release);
  assert.equal(writes, 2);
});
