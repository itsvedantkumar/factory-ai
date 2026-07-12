import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkspaceTools } from "../src/workspace-tools.js";

test("reads and writes only inside the assigned workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-tools-"));
  await writeFile(path.join(root, "README.md"), "before");
  const tools = createWorkspaceTools(root);

  assert.equal(await tools.read_file.execute({ path: "README.md" }), "before");
  await tools.write_file.execute({ path: "src/new.js", content: "export const ready = true;\n" });
  assert.equal(await readFile(path.join(root, "src/new.js"), "utf8"), "export const ready = true;\n");
  await assert.rejects(() => tools.read_file.execute({ path: "../secret" }), /outside workspace/);
  await assert.rejects(() => tools.write_file.execute({ path: "/tmp/escape", content: "no" }), /outside workspace/);
});

test("runs allowlisted commands without inherited credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-tools-"));
  const calls = [];
  const tools = createWorkspaceTools(root, {
    execute: async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, stdout: "ok", stderr: "" };
    },
  });

  assert.equal(await tools.run_command.execute({ command: "npm", args: ["test"] }), "ok");
  assert.equal(calls[0].options.inheritEnv, false);
  await assert.rejects(() => tools.run_command.execute({ command: "curl", args: ["https://example.com"] }), /Command not allowed/);
  await assert.rejects(() => tools.run_command.execute({ command: "git", args: ["push", "origin", "main"] }), /Git operation not allowed/);
});

test("lists files with bounded output and excludes git internals", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-tools-"));
  await writeFile(path.join(root, "a.txt"), "a");
  const tools = createWorkspaceTools(root);
  const files = JSON.parse(await tools.list_files.execute({ path: "." }));
  assert.deepEqual(files, ["a.txt"]);
});
