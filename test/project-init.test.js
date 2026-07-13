import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeProject } from "../src/project-init.js";

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
