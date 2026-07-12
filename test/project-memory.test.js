import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../src/project-memory.js";

test("persists and scopes durable context by repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-memory-"));
  const memory = new ProjectMemory(directory);
  await memory.append({ repository: "owner/a", objective: "first", pullRequest: "pr1" });
  await memory.append({ repository: "owner/b", objective: "other", pullRequest: "pr2" });
  await memory.append({ repository: "owner/a", objective: "second", pullRequest: "pr3" });
  const context = await memory.context("owner/a");
  assert.deepEqual(context.map((item) => item.objective), ["first", "second"]);
  assert.ok(context.every((item) => item.recordedAt));
});
