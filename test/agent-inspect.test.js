import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { inspectAgentDiff } from "../src/agent-inspect.js";

test("returns a bounded agent-only live diff and excludes sensitive path classes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-agent-diff-"));
  const directory = path.join(root, "objective", "tasks", "builder");
  await mkdir(path.join(directory, ".git"), { recursive: true });
  const calls = [];
  const execute = async (command, args) => {
    calls.push(args);
    if (command === "/usr/bin/docker") return { code: 0, stdout: '{"objectiveId":"objective","taskId":"builder","source":"working-tree","status":"working tree has changes","patch":"diff --git a/src/app.js b/src/app.js\\n+const value = 1;","truncated":false}\n', stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const result = await inspectAgentDiff({ workspaceRoot: await realpath(root), objectiveId: "objective", taskId: "builder", workerImage: "agent-factory-worker:test", execute });
  assert.match(result.patch, /const value = 1/);
  assert.equal(result.source, "working-tree");
  assert.ok(calls.some((args) => args.includes("none") && args.some((value) => value.endsWith(":/workspace:ro")) && args.includes("ALL")));
});

test("rejects traversal identifiers before reading a worktree", async () => {
  await assert.rejects(() => inspectAgentDiff({ workspaceRoot: "/tmp", objectiveId: "../escape", taskId: "builder" }), /Invalid objective/);
});

test("CLI rejects an injected diff format before contacting Azure", () => {
  const result = spawnSync("bash", ["bin/factory", "agent", "diff", "objective", "builder", "--json';touch /tmp/pwn"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: factory agent diff/);
});
