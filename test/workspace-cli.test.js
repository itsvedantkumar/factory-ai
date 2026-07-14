import test from "node:test";
import assert from "node:assert/strict";
import { runWorkspaceCLI } from "../src/workspace-cli.js";

test("workspace sync enable records consent, starts scheduler, and syncs now", async () => {
  const calls = [];
  const catalog = {
    setSync: async (name, enabled) => { calls.push(["set", name, enabled]); return { name, sync: { enabled } }; },
    sync: async (name) => { calls.push(["sync", name]); return { name, status: "synced" }; },
  };
  const scheduler = { enable: async () => { calls.push(["scheduler", "enable"]); return { enabled: true }; } };
  const result = await runWorkspaceCLI(["sync", "enable", "app"], { catalog, scheduler, initialize: async () => {} });
  assert.equal(result.status, "synced");
  assert.deepEqual(calls, [["scheduler", "enable"], ["sync", "app"], ["set", "app", true]]);
});

test("workspace sync runner continues after one blocked workspace", async () => {
  const catalog = {
    syncEnabled: async () => [{ name: "good" }, { name: "blocked" }],
    sync: async (name) => { if (name === "blocked") throw new Error("dirty"); return { name, status: "pulled" }; },
  };
  const result = await runWorkspaceCLI(["sync", "run"], { catalog, scheduler: {}, initialize: async () => {} });
  assert.deepEqual(result, [{ name: "good", status: "pulled" }, { name: "blocked", status: "blocked", error: "dirty" }]);
});

test("workspace sync enable rolls back consent and persistence when initial sync fails", async () => {
  const calls = [];
  const catalog = {
    setSync: async (name, enabled) => { calls.push(["set", name, enabled]); },
    sync: async () => { throw new Error("dirty"); },
    syncEnabled: async () => [],
  };
  const scheduler = {
    enable: async () => calls.push(["scheduler", "enable"]),
    disable: async () => calls.push(["scheduler", "disable"]),
  };
  await assert.rejects(() => runWorkspaceCLI(["sync", "enable", "app"], { catalog, scheduler, initialize: async () => {} }), /dirty/);
  assert.deepEqual(calls, [["scheduler", "enable"], ["scheduler", "disable"]]);
});

test("workspace import removes a new catalog entry when project initialization fails", async () => {
  const calls = [];
  const catalog = {
    list: async () => [],
    import: async () => ({ name: "app", localPath: "/tmp/app" }),
    remove: async (name) => calls.push(["remove", name]),
  };
  await assert.rejects(() => runWorkspaceCLI(["import", "acme/app"], { catalog, scheduler: {}, initialize: async () => { throw new Error("template failed"); } }), /template failed/);
  assert.deepEqual(calls, [["remove", "app"]]);
});

test("workspace import reports distinct progress stages before returning", async () => {
  const stages = [];
  const catalog = {
    list: async () => [],
    import: async () => ({ name: "app", repository: "acme/app", localPath: "/tmp/app" }),
  };
  const result = await runWorkspaceCLI(["import", "acme/app"], {
    catalog,
    scheduler: {},
    initialize: async () => {},
    progress: (event) => stages.push(event),
  });
  assert.equal(result.name, "app");
  assert.deepEqual(stages.map((event) => event.stage), ["resolve", "initialize", "ready"]);
  assert.ok(stages.every((event) => event.current >= 1 && event.current <= event.total));
});
