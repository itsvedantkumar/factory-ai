import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceCatalog, workspaceInternals } from "../src/workspace-catalog.js";

test("imports local GitHub repositories into a durable named catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-catalog-"));
  const repo = path.join(root, "repo"); await mkdir(repo);
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json"), root: path.join(root, "managed"), execute: async (_command, args) => ({ code: 0, stdout: args.includes("get-url") ? "git@github.com:acme/payments.git\n" : "develop\n", stderr: "" }) });
  const imported = await catalog.import(repo, { name: "payments-api" });
  assert.equal(imported.repository, "acme/payments");
  assert.equal(imported.baseBranch, "develop");
  assert.equal((await catalog.resolve("payments-api")).localPath, await realpath(repo));
  assert.equal((await catalog.list()).length, 1);
});

test("imports owner/repo into the managed workspace root once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-catalog-"));
  const calls = [];
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json"), root: path.join(root, "managed"), execute: async (command, args) => { calls.push([command, args]); if (command === "gh") await mkdir(args[3], { recursive: true }); return { code: 0, stdout: args.includes("get-url") ? "https://github.com/acme/app.git\n" : args.includes("symbolic-ref") ? "origin/main\n" : "", stderr: "" }; } });
  const imported = await catalog.import("acme/app");
  assert.equal(imported.name, "app");
  assert.equal(calls.filter(([command]) => command === "gh").length, 1);
  assert.equal((await catalog.remove("app")).filesPreserved, true);
});

test("resolves direct repositories for backwards compatibility and validates remotes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-catalog-"));
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json") });
  assert.equal((await catalog.resolve("acme/app")).url, "https://github.com/acme/app.git");
  assert.throws(() => workspaceInternals.repositoryFromRemote("https://gitlab.com/acme/app.git"), /github.com/);
  await assert.rejects(() => catalog.resolve("missing"), /Unknown workspace/);
});
