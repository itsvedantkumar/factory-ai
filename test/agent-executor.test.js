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

test("quick prompts execute once as read-only actions and return a separate result", async () => {
  const emitted = [];
  const executor = new AgentExecutor({
    workspaces: {
      prepareAction: async () => "/workspace/action",
    },
    agentRunner: { invoke: async () => ({ summary: "The router maps routes.", checks: [], risks: [], approval: "not_applicable" }) },
    sendControl: async (message) => emitted.push(message),
  });
  await executor.process({
    type: "quick_action_task",
    actionId: "action-123",
    action: { id: "action-123", type: "quick_action", kind: "prompt", prompt: "Explain the router", workspace: "app", repository: "https://github.com/acme/app.git", baseBranch: "main", createdAt: "2026-07-15T00:00:00.000Z" },
    task: { id: "respond", role: "scout", title: "Respond", instructions: "Explain the router", dependsOn: [], capabilities: [], complexity: "simple" },
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "quick_action_result");
  assert.equal(emitted[0].actionId, "action-123");
  assert.equal(emitted[0].summary, "The router maps routes.");
});

test("quick prompt envelopes must match their validated action identity", async () => {
  const executor = new AgentExecutor({ workspaces: {}, agentRunner: {}, sendControl: async () => {} });
  await assert.rejects(() => executor.process({
    type: "quick_action_task",
    actionId: "action-safe",
    action: { id: "../escape", type: "quick_action", kind: "prompt", prompt: "Explain", workspace: "app", repository: "https://github.com/acme/app.git", baseBranch: "main", createdAt: "2026-07-15T00:00:00.000Z" },
    task: { id: "respond", role: "scout", title: "Respond", instructions: "Explain", dependsOn: [], capabilities: [], complexity: "simple" },
  }), /invalid|Action ID|match/i);
});

test("injects trusted scanner evidence into security tasks", async () => {
  let prompt;
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async () => "/workspace/security",
      reference: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/o/security" }),
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

test("blocks authoring checkpoints when the pre-push secret scan fails", async () => {
  let checkpointed = false;
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async () => "/workspace/build",
      checkpoint: async () => { checkpointed = true; return {}; },
    },
    scannerSuite: { scan: async () => [{ scanner: "gitleaks", status: "findings", output: "redacted" }] },
    agentRunner: { invoke: async () => ({ summary: "built", checks: [], risks: [], approval: "not_applicable" }) },
    sendControl: async () => {},
  });
  await assert.rejects(() => executor.process({
    type: "agent_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Build", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    task: { id: "build", role: "builder", title: "Build", instructions: "Build it", dependsOn: [], capabilities: [] },
  }), /secret scan/);
  assert.equal(checkpointed, false);
});

test("injects a recovered durable worktree checkpoint on redelivery", async () => {
  let prompt;
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async () => "/workspace/build",
      recoveryContext: async () => "RECOVERED DURABLE WORKTREE CHECKPOINT\n M src/app.js",
      checkpoint: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/o/build" }),
    },
    agentRunner: { invoke: async (packet) => { prompt = packet.prompt; return { summary: "built", checks: [], risks: [], approval: "not_applicable" }; } },
    sendControl: async () => {},
  });
  await executor.process({
    type: "agent_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Build", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    task: { id: "build", role: "builder", title: "Build", instructions: "Build it", dependsOn: [], capabilities: [] },
  });
  assert.match(prompt, /RECOVERED DURABLE WORKTREE CHECKPOINT/);
  assert.match(prompt, /src\/app\.js/);
});

test("configured scanner hooks fail closed before checkpoint", async () => {
  let checkpointed = false;
  const executor = new AgentExecutor({
    workspaces: { prepareTask: async () => "/workspace", checkpoint: async () => { checkpointed = true; return {}; } },
    agentRunner: { invoke: async () => ({ summary: "done", checks: [], risks: [], approval: "not_applicable" }) },
    hooks: [{ point: "before_checkpoint", action: "scanner", input: { scanners: ["gitleaks"] } }],
    hookHandlers: { scanner: async () => [{ scanner: "gitleaks", status: "findings", output: "redacted" }] },
    sendControl: async () => {},
  });
  await assert.rejects(() => executor.process({ type: "agent_task", objectiveId: "o", objective: { id: "o", objective: "Build", repository: "https://github.com/a/b.git", baseBranch: "main" }, task: { id: "build", role: "builder", title: "Build", instructions: "Build safely", dependsOn: [], capabilities: [] } }), /scanner hook/);
  assert.equal(checkpointed, false);
});

test("approved policy replay proceeds to checkpoint without a second request", async () => {
  let checkpointed = false;
  const executor = new AgentExecutor({
    workspaces: { prepareTask: async () => "/workspace", checkpoint: async () => { checkpointed = true; return { commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/o/build" }; } },
    agentRunner: { invoke: async () => ({ summary: "done", checks: [], risks: [], approval: "not_applicable" }) },
    hooks: [{ point: "before_checkpoint", action: "policy_check", input: { policies: ["new_dependencies"] } }],
    hookHandlers: { policy_check: async () => ({ required: true, policies: ["new_dependencies"], skipped: true }) },
    sendControl: async () => {},
  });
  await executor.process({ type: "agent_task", objectiveId: "o", approvalGranted: true, objective: { id: "o", objective: "Build", repository: "https://github.com/a/b.git", baseBranch: "main" }, task: { id: "build", role: "builder", title: "Build", instructions: "Add dependency", dependsOn: [], capabilities: [] } });
  assert.equal(checkpointed, true);
});

test("injects a repository map before semantic snippets for worker tasks", async () => {
  let prompt;
  const executor = new AgentExecutor({
    workspaces: {
      prepareTask: async () => "/workspace/build",
      checkpoint: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567", branch: "factory-ai/o/build" }),
    },
    buildRepoMap: async () => ({ text: "REPOSITORY MAP\nsrc/auth.js:4", entries: [{ path: "src/auth.js", startLine: 4, endLine: 4 }] }),
    repoMapMaxCharacters: 4321,
    retriever: { context: async (_directory, _repository, _query, options) => {
      assert.deepEqual(options.repositoryEntries, [{ path: "src/auth.js", startLine: 4, endLine: 4 }]);
      return "src/session.js:2";
    } },
    agentRunner: { invoke: async (packet) => { prompt = packet.prompt; return { summary: "built", checks: [], risks: [], approval: "not_applicable" }; } },
    sendControl: async () => {},
  });
  await executor.process({
    type: "agent_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Fix auth", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    task: { id: "build", role: "builder", title: "Build", instructions: "Build it", dependsOn: [], capabilities: [] },
  });
  assert.ok(prompt.indexOf("REPOSITORY MAP") < prompt.indexOf("LOCAL SEMANTIC CONTEXT"));
});

test("injects a repository map before semantic snippets for planning", async () => {
  let context;
  const executor = new AgentExecutor({
    workspaces: { ensureObjective: async () => "/workspace/control" },
    buildRepoMap: async () => ({ text: "REPOSITORY MAP\nsrc/auth.js:4", entries: [] }),
    retriever: { context: async () => "src/session.js:2" },
    agentRunner: { plan: async (_objective, _directory, value) => { context = value; return { executiveIntent: "ship", tasks: [] }; } },
    sendControl: async () => {},
  });
  await executor.process({
    type: "planning_task",
    objectiveId: "objective1",
    objective: { id: "objective1", objective: "Fix auth", repository: "https://github.com/acme/app.git", baseBranch: "main" },
  });
  assert.deepEqual(context.map((item) => item.type), ["repository-map", "local-semantic-retrieval"]);
});
