import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkspaceSyncScheduler } from "../src/workspace-sync-scheduler.js";

test("installs a persistent macOS launch agent for enabled workspace sync", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "factory-sync-scheduler-"));
  const calls = [];
  const scheduler = new WorkspaceSyncScheduler({ home, platform: "darwin", uid: 501, nodePath: "/opt/node", cliPath: "/opt/factory/workspace-cli.js", pathValue: "/opt/bin:/usr/bin", execute: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: "", stderr: "" }; } });
  await scheduler.enable();
  const plist = await readFile(path.join(home, "Library", "LaunchAgents", "com.factory-ai.workspace-sync.plist"), "utf8");
  assert.match(plist, /<integer>60<\/integer>/);
  assert.match(plist, /<string>sync<\/string>\s*<string>run<\/string>/);
  assert.match(plist, /<string>\/opt\/node<\/string>/);
  assert.ok(calls.some(([command, args]) => command === "launchctl" && args.includes("bootstrap")));
});

test("installs a persistent Linux user timer without root", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "factory-sync-scheduler-"));
  const calls = [];
  const scheduler = new WorkspaceSyncScheduler({ home, platform: "linux", nodePath: "/opt/node", cliPath: "/opt/factory/workspace-cli.js", execute: async (command, args) => { calls.push([command, args]); return { code: 0, stdout: "", stderr: "" }; } });
  await scheduler.enable();
  const timer = await readFile(path.join(home, ".config", "systemd", "user", "factory-ai-workspace-sync.timer"), "utf8");
  const service = await readFile(path.join(home, ".config", "systemd", "user", "factory-ai-workspace-sync.service"), "utf8");
  assert.match(timer, /OnUnitActiveSec=60s/);
  assert.match(service, /sync run/);
  assert.ok(calls.some(([command, args]) => command === "systemctl" && args.includes("--user") && args.includes("enable")));
});

test("removes partial persistence when scheduler activation fails", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "factory-sync-scheduler-"));
  const scheduler = new WorkspaceSyncScheduler({ home, platform: "darwin", uid: 501, nodePath: "/opt/node", cliPath: "/opt/factory/workspace-cli.js", pathValue: "/usr/bin", execute: async (_command, args) => { if (args.includes("bootstrap")) throw new Error("bootstrap failed"); return { code: 0, stdout: "", stderr: "" }; } });
  await assert.rejects(() => scheduler.enable(), /bootstrap failed/);
  await assert.rejects(() => readFile(path.join(home, "Library", "LaunchAgents", "com.factory-ai.workspace-sync.plist")), /ENOENT/);
});
