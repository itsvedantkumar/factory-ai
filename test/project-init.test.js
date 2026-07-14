import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { excludeLocalProjectContext, initializeProject, supportsLocalProjectContext } from "../src/project-init.js";

test("initializes workspace instructions without overwriting repository policy", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  await writeFile(path.join(target, "AGENTS.md"), "KEEP_POLICY\n");
  const context = await initializeProject(target, path.resolve("templates"));
  assert.equal(await readFile(path.join(target, "AGENTS.md"), "utf8"), "KEEP_POLICY\n");
  assert.match(await readFile(path.join(context, "project.md"), "utf8"), /Project/);
});

test("rejects symbolic-link project context destinations", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "factory-outside-"));
  await symlink(outside, path.join(target, ".agent-factory"));
  await assert.rejects(() => initializeProject(target, path.resolve("templates")), /symbolic link/);
});

test("excludes Factory-generated context from the local Git worktree", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  await mkdir(path.join(target, ".git", "info"), { recursive: true });
  await writeFile(path.join(target, ".git", "info", "exclude"), "# existing\n");
  await initializeProject(target, path.resolve("templates"));
  await excludeLocalProjectContext(target);
  await excludeLocalProjectContext(target);
  const value = await readFile(path.join(target, ".git", "info", "exclude"), "utf8");
  assert.equal((value.match(/\/AGENTS\.md/g) ?? []).length, 1);
  assert.equal((value.match(/\/\.agent-factory\/project\.md/g) ?? []).length, 1);
  assert.equal((value.match(/\/\.agent-factory\/\.local-files\.json/g) ?? []).length, 1);
});

test("does not exclude pre-existing user-owned context files", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  await mkdir(path.join(target, ".git", "info"), { recursive: true });
  await mkdir(path.join(target, ".agent-factory"));
  await writeFile(path.join(target, "AGENTS.md"), "USER POLICY\n");
  await writeFile(path.join(target, ".agent-factory", "custom.md"), "USER CONTEXT\n");
  await initializeProject(target, path.resolve("templates"));
  await excludeLocalProjectContext(target);
  const value = await readFile(path.join(target, ".git", "info", "exclude"), "utf8");
  assert.doesNotMatch(value, /^\/AGENTS\.md$/m);
  assert.doesNotMatch(value, /custom\.md/);
});

test("rejects a symlinked generated-file marker", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  const outside = path.join(await mkdtemp(path.join(os.tmpdir(), "factory-outside-")), "marker.json");
  await mkdir(path.join(target, ".git", "info"), { recursive: true });
  await mkdir(path.join(target, ".agent-factory"));
  await writeFile(outside, "KEEP\n");
  await symlink(outside, path.join(target, ".agent-factory", ".local-files.json"));
  await assert.rejects(() => initializeProject(target, path.resolve("templates")), /marker must be a regular file/);
  assert.equal(await readFile(outside, "utf8"), "KEEP\n");
});

test("does not modify shared exclusions for linked Git worktrees", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  await writeFile(path.join(target, ".git"), "gitdir: /tmp/shared/worktree\n");
  assert.equal(await supportsLocalProjectContext(target), false);
  assert.equal(await excludeLocalProjectContext(target), null);
});

test("rejects marker paths that could inject Git exclude patterns", async () => {
  const target = await mkdtemp(path.join(os.tmpdir(), "factory-init-"));
  await mkdir(path.join(target, ".git", "info"), { recursive: true });
  await mkdir(path.join(target, ".agent-factory"));
  await writeFile(path.join(target, ".agent-factory", ".local-files.json"), '["\\n*"]\n');
  await assert.rejects(() => excludeLocalProjectContext(target), /invalid path/);
});
