import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "../src/process.js";
import { WorkspaceManager } from "../src/workspace.js";

test("creates a self-contained clone for every task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-workspace-"));
  const source = path.join(root, "source");
  await mkdir(source);
  await run("git", ["init", "-b", "main"], { cwd: source });
  await run("git", ["config", "user.name", "Test"], { cwd: source });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: source });
  await writeFile(path.join(source, "README.md"), "test\n");
  await run("git", ["add", "."], { cwd: source });
  await run("git", ["commit", "-m", "init"], { cwd: source });
  const manager = new WorkspaceManager(path.join(root, "workspaces"), 30_000);
  const directory = await manager.prepareTask(
    { id: "objective1", repository: source, baseBranch: "main" },
    { id: "build", role: "builder" },
    [],
  );
  assert.equal((await stat(path.join(directory, ".git"))).isDirectory(), true);
});
