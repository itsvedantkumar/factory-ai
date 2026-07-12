import test from "node:test";
import assert from "node:assert/strict";
import { ContainerAgentRunner } from "../src/container-runner.js";

test("launches each task in a bounded hardened container without secrets in arguments", async () => {
  const calls = [];
  const runner = new ContainerAgentRunner({
    image: "ghcr.io/acme/factory@sha256:abc",
    timeoutMs: 60_000,
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
  assert.ok(call.args.includes("--read-only"));
  assert.ok(call.args.includes("no-new-privileges"));
  assert.ok(call.args.includes("--cap-drop"));
  assert.ok(call.args.includes("--pids-limit"));
  assert.ok(call.args.includes("--memory"));
  assert.ok(call.args.includes("TEXTVED_AZURE_API_KEY"));
  assert.equal(call.args.some((value) => value.includes("primary-secret-value")), false);
  assert.match(call.options.input, /"build000"/);
});

test("uses the same isolation boundary for planning", async () => {
  const calls = [];
  const runner = new ContainerAgentRunner({
    image: "factory:test",
    timeoutMs: 60_000,
    execute: async (_command, _args, options) => {
      calls.push(options);
      return { stdout: '{"executiveIntent":"ship","tasks":[]}\n', stderr: "", code: 0 };
    },
  });
  const result = await runner.plan({ id: "objective1", objective: "Ship" }, "/workspaces/objective1/control");
  assert.equal(result.executiveIntent, "ship");
  assert.match(calls[0].input, /"mode":"plan"/);
});
