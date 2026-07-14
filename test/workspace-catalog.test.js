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
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json"), root: path.join(root, "managed"), execute: async (command, args) => { calls.push([command, args]); if (command === "gh") await mkdir(path.join(args[3], ".git"), { recursive: true }); return { code: 0, stdout: args.includes("get-url") ? "https://github.com/acme/app.git\n" : args.includes("symbolic-ref") ? "origin/main\n" : "", stderr: "" }; } });
  const imported = await catalog.import("acme/app");
  assert.equal(imported.name, "app");
  assert.equal(calls.filter(([command]) => command === "gh").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 2));
  const repeated = await catalog.import("acme/app");
  assert.equal(repeated.importedAt, imported.importedAt);
  assert.equal((await catalog.remove("app")).filesPreserved, true);
});

test("resolves direct repositories for backwards compatibility and validates remotes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-catalog-"));
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json") });
  assert.equal((await catalog.resolve("acme/app")).url, "https://github.com/acme/app.git");
  assert.throws(() => workspaceInternals.repositoryFromRemote("https://gitlab.com/acme/app.git"), /github.com/);
  await assert.rejects(() => catalog.resolve("missing"), /Unknown workspace/);
});

async function syncCatalog(outputs = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-sync-"));
  const repo = path.join(root, "repo"); await mkdir(repo);
  const calls = [];
  const execute = async (command, args) => {
    calls.push([command, args]);
    const joined = args.join(" ");
    if (joined.includes("remote get-url")) return { code: 0, stdout: "https://github.com/acme/app.git\n", stderr: "" };
    if (joined.includes("symbolic-ref --short HEAD")) return { code: 0, stdout: "main\n", stderr: "" };
    if (joined.includes("status --porcelain")) return { code: 0, stdout: outputs.status ?? "", stderr: "" };
    if (joined.includes("status --ignored")) return { code: 0, stdout: outputs.ignored ?? "", stderr: "" };
    if (joined.includes("diff --name-only")) return { code: 0, stdout: outputs.changed ?? "", stderr: "" };
    if (joined.includes("rev-parse HEAD")) return { code: 0, stdout: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", stderr: "" };
    if (joined.includes("rev-parse origin/main")) return { code: 0, stdout: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", stderr: "" };
    if (joined.includes("rev-list --left-right --count")) return { code: 0, stdout: outputs.counts ?? "0\t0\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const catalog = new WorkspaceCatalog({ file: path.join(root, "catalog.json"), root: path.join(root, "managed"), execute });
  await catalog.save([{ name: "app", repository: "acme/app", localPath: await realpath(repo), baseBranch: "main" }]);
  return { catalog, calls };
}

test("workspace sync fast-forwards clean branches that are behind GitHub", async () => {
  const { catalog, calls } = await syncCatalog({ counts: "0\t2\n" });
  const result = await catalog.sync("app");
  assert.equal(result.status, "pulled");
  assert.ok(calls.some(([, args]) => args.includes("--ff-only")));
  assert.equal((await catalog.resolve("app")).sync.lastStatus, "pulled");
});

test("workspace sync pushes clean local commits without force", async () => {
  const { catalog, calls } = await syncCatalog({ counts: "3\t0\n" });
  const result = await catalog.sync("app");
  assert.equal(result.status, "pushed");
  const push = calls.find(([, args]) => args.includes("push"));
  assert.deepEqual(push?.[1].slice(-2), ["https://github.com/acme/app.git", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:refs/heads/main"]);
  assert.ok(!push[1].some((value) => value.includes("force")));
  assert.ok(push[1].includes("core.hooksPath=/dev/null"));
});

test("workspace sync blocks upstream paths that would overwrite ignored local files", async () => {
  const { catalog, calls } = await syncCatalog({ counts: "0\t1\n", changed: "secrets/key\0", ignored: "!! secrets/\0" });
  await assert.rejects(() => catalog.sync("app"), /ignored local files/);
  assert.ok(!calls.some(([, args]) => args.includes("merge")));
});

test("workspace sync blocks upstream ancestors of ignored local files", async () => {
  const { catalog, calls } = await syncCatalog({ counts: "0\t1\n", changed: "secrets\0", ignored: "!! secrets/key\0" });
  await assert.rejects(() => catalog.sync("app"), /ignored local files/);
  assert.ok(!calls.some(([, args]) => args.includes("merge")));
});

test("workspace sync blocks dirty and divergent work without modifying it", async () => {
  const dirty = await syncCatalog({ status: " M src/app.js\n" });
  await assert.rejects(() => dirty.catalog.sync("app"), /uncommitted changes/);
  assert.ok(!dirty.calls.some(([, args]) => args.includes("push") || args.includes("merge")));

  const diverged = await syncCatalog({ counts: "1\t1\n" });
  await assert.rejects(() => diverged.catalog.sync("app"), /diverged/);
  assert.ok(!diverged.calls.some(([, args]) => args.includes("push") || args.includes("merge")));
});

test("workspace sync permission is explicit and persisted per workspace", async () => {
  const { catalog } = await syncCatalog();
  const enabled = await catalog.setSync("app", true);
  assert.equal(enabled.sync.enabled, true);
  assert.equal((await catalog.syncEnabled()).length, 1);
  const disabled = await catalog.setSync("app", false);
  assert.equal(disabled.sync.enabled, false);
  assert.equal((await catalog.syncEnabled()).length, 0);
});
