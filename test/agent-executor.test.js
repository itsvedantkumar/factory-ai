import test from "node:test";
import assert from "node:assert/strict";
import { AgentExecutor } from "../src/agent-executor.js";

test("delegates planning to an isolated planner agent and emits only its result", async () => {
  const emitted = [];
  const executor = new AgentExecutor({
    workspaces: { ensureObjective: async () => "/workspace/control" },
    agentRunner: { plan: async () => ({ executiveIntent: "ship", tasks: [] }) },
    sendControl: async (message) => emitted.push(message),
  });
  await executor.process({
    type: "planning_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Ship", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    task: { id: "planner0", role: "planner" },
  });
  assert.deepEqual(emitted, [{
    type: "planning_result",
    objectiveId: "objective1",
    delivery: { executiveIntent: "ship", tasks: [] },
  }]);
});

test("executes exactly one assigned task without reading orchestration state", async () => {
  const calls = [];
  const emitted = [];
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async (...args) => { calls.push(["prepare", ...args]); return "/workspace/task"; },
      checkpoint: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/objective1/build000" }),
    },
    agentRunner: {
      invoke: async (packet) => { calls.push(["invoke", packet]); return { summary: "built", checks: ["npm test"], risks: [], approval: "not_applicable" }; },
    },
    sendControl: async (message) => emitted.push(message),
  });
  const objective = { id: "objective1", objective: "Ship", repository: "https://github.com/acme/app.git", baseBranch: "main" };
  const task = { id: "build000", role: "builder", title: "Build", instructions: "Implement", dependsOn: [], capabilities: [] };
  await executor.process({ type: "agent_task", objectiveId: "objective1", objective, task, dependencyCommits: [] });
  assert.equal(calls.filter(([name]) => name === "invoke").length, 1);
  assert.equal(emitted[0].type, "result");
  assert.equal(emitted[0].taskId, "build000");
});

test("injects trusted scanner evidence into security tasks", async () => {
  let prompt;
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async () => "/workspace/security",
      checkpoint: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/o/security" }),
    },
    scannerSuite: { scan: async () => [{ scanner: "gitleaks", status: "passed", output: "no leaks" }] },
    agentRunner: { invoke: async (packet) => { prompt = packet.prompt; return { summary: "safe", checks: [], risks: [], approval: "approved" }; } },
    sendControl: async () => {},
  });
  await executor.process({
    type: "agent_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Review", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    task: { id: "security", role: "security", title: "Review", instructions: "Review", dependsOn: [], capabilities: [] },
    dependencyCommits: [],
  });
  assert.match(prompt, /TRUSTED SCANNER EVIDENCE/);
  assert.match(prompt, /gitleaks/);
});
