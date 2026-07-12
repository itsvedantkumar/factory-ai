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
