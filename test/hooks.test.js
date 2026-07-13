import test from "node:test";
import assert from "node:assert/strict";
import { HOOK_ACTIONS, HOOK_POINTS, runHooks, validateHooks } from "../src/hooks.js";

test("accepts typed built-in hooks at every supported hook point", () => {
  const hooks = validateHooks([
    { point: "before_plan", action: "policy_check", input: { policies: ["new_dependencies"] } },
    { point: "after_plan", action: "notification", input: { message: "Plan ready" } },
    { point: "before_tool_batch", action: "scanner", input: { scanners: ["trivy"] } },
    { point: "after_tool_batch", action: "snapshot", input: { label: "tools-complete" } },
    { point: "before_checkpoint", action: "approval_request", input: { policy: "external_side_effects", reason: "Publishing changes" } },
    { point: "before_release", action: "scanner", input: {} },
  ]);

  assert.deepEqual(HOOK_POINTS, ["before_plan", "after_plan", "before_tool_batch", "after_tool_batch", "before_checkpoint", "before_release"]);
  assert.deepEqual(HOOK_ACTIONS, ["scanner", "policy_check", "notification", "snapshot", "approval_request"]);
  assert.equal(hooks.length, 6);
});

test("rejects shell hooks and command-shaped built-in inputs", () => {
  assert.throws(() => validateHooks([{ point: "before_release", action: "shell", input: { command: "curl example.com" } }]));
  assert.throws(() => validateHooks([{ point: "before_release", action: "scanner", input: { command: "sh", scanners: [] } }]));
  assert.throws(() => validateHooks([{ point: "before_release", action: "notification", input: { message: "ok", env: {} } }]));
});

test("requires approval policies to be aggregated into one hook per checkpoint", () => {
  assert.throws(() => validateHooks([
    { point: "before_checkpoint", action: "approval_request", input: { policy: "new_dependencies", reason: "Dependencies" } },
    { point: "before_checkpoint", action: "approval_request", input: { policy: "infrastructure_changes", reason: "Infrastructure" } },
  ]), /one aggregated approval hook/);
});

test("runs matching hooks in declaration order through built-in handlers", async () => {
  const calls = [];
  const hooks = validateHooks([
    { point: "before_release", action: "policy_check", input: { policies: ["infrastructure_changes"] } },
    { point: "before_plan", action: "snapshot", input: {} },
    { point: "before_release", action: "notification", input: { message: "Awaiting release" } },
  ]);
  const handlers = {
    policy_check: async (input, context) => { calls.push(["policy", input, context]); return "allowed"; },
    notification: async (input, context) => { calls.push(["notification", input, context]); return "sent"; },
  };

  const results = await runHooks(hooks, "before_release", handlers, { objectiveId: "objective1" });

  assert.deepEqual(results, [
    { action: "policy_check", result: "allowed" },
    { action: "notification", result: "sent" },
  ]);
  assert.deepEqual(calls.map(([name]) => name), ["policy", "notification"]);
});

test("fails closed when a configured built-in handler is unavailable", async () => {
  const hooks = validateHooks([{ point: "before_plan", action: "snapshot", input: {} }]);
  await assert.rejects(runHooks(hooks, "before_plan", {}, {}), /Missing built-in hook handler: snapshot/);
});
