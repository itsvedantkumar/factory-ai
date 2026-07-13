import test from "node:test";
import assert from "node:assert/strict";
import { ContainerAgentRunner } from "../src/container-runner.js";

test("launches each task in a bounded hardened container without secrets in arguments", async () => {
  const calls = [];
  const runner = new ContainerAgentRunner({
    image: "ghcr.io/acme/factory@sha256:abc",
    memoryDir: "/state/memory",
    timeoutMs: 60_000,
    prepareMemory: async () => "/state/memory/0123456789abcdef01234567",
    environment: { TEXTVED_AZURE_API_KEY: "primary-secret-value" },
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}\n', stderr: "", code: 0 };
    },
  });
  await runner.invoke({
    objective: { id: "objective1", objective: "Ship" },
    task: { id: "build000", role: "builder", instructions: "Build", capabilities: [] },
    directory: "/workspaces/objective1/tasks/build000",
    prompt: "Execute",
  });
  const call = calls[0];
  assert.equal(call.command, "docker");
  assert.ok(call.args.includes("-i"));
  assert.ok(call.args.includes("--read-only"));
  assert.ok(call.args.includes("no-new-privileges"));
  assert.ok(call.args.includes("--cap-drop"));
  assert.ok(call.args.includes("--pids-limit"));
  assert.ok(call.args.includes("--memory"));
  assert.equal(call.args.includes("TEXTVED_AZURE_API_KEY"), false);
  assert.ok(call.args.some((value) => /^\/state\/memory\/[0-9a-f]{24}:\/memory:ro$/.test(value)));
  assert.equal(call.args.some((value) => value.includes("primary-secret-value")), false);
  assert.match(call.options.input, /"build000"/);
  assert.match(call.options.input, /"runtimeEnvironment"/);
});

test("uses the same isolation boundary for planning", async () => {
  const calls = [];
  const runner = new ContainerAgentRunner({
    image: "factory:test",
    memoryDir: "/state/memory",
    timeoutMs: 60_000,
    prepareMemory: async () => "/state/memory/0123456789abcdef01234567",
    execute: async (_command, args, options) => {
      calls.push({ args, options });
      return { stdout: '{"executiveIntent":"ship","tasks":[]}\n', stderr: "", code: 0 };
    },
  });
  const result = await runner.plan({ id: "objective1", objective: "Ship" }, "/workspaces/objective1/control", [{ type: "prior", content: "verified" }]);
  assert.equal(result.executiveIntent, "ship");
  assert.match(calls[0].options.input, /"mode":"plan"/);
  assert.match(calls[0].options.input, /"content":"verified"/);
  assert.ok(calls[0].args.includes("/workspaces/objective1/control:/workspace:ro"));
});

test("streams container activity events into durable host state", async () => {
  const events = [];
  const runner = new ContainerAgentRunner({
    image: "factory:test",
    memoryDir: "/state/memory",
    timeoutMs: 60_000,
    prepareMemory: async () => "/state/memory/0123456789abcdef01234567",
    activityStore: { append: async (objectiveId, taskId, event) => events.push({ objectiveId, taskId, event }) },
    execute: async (_command, _args, options) => {
      options.onStderr(Buffer.from('@factory-event {"type":"tool.started","tool":"read_file"}\n'));
      return { stdout: '{"summary":"ok","checks":[],"risks":[],"approval":"not_applicable"}\n', stderr: "", code: 0 };
    },
  });
  await runner.invoke({ objective: { id: "objective1", objective: "Ship" }, task: { id: "build", role: "builder", instructions: "Build", capabilities: [] }, directory: "/workspace/build", prompt: "work" });
  assert.ok(events.some((item) => item.event.type === "tool.started" && item.event.tool === "read_file"));
  assert.ok(events.some((item) => item.event.type === "container.completed"));
});
