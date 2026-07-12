import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  aggregateDashboard,
  humanDuration,
  loadLocalState,
  renderDashboard,
  stableStringify,
  loadQueueMetrics,
  loadAzureCost,
} from "../src/dashboard.js";

const state = {
  objective: { id: "objective-1", objective: "Ship dashboard", repository: "https://github.com/acme/app.git" },
  status: "running",
  createdAt: "2026-07-12T10:00:00.000Z",
  tasks: [
    { id: "build-one", role: "builder", title: "Build", dependsOn: [] },
    { id: "test-one", role: "tester", title: "Test", dependsOn: ["build-one"] },
  ],
  results: {
    "build-one": {
      status: "succeeded",
      startedAt: "2026-07-12T10:01:00.000Z",
      completedAt: "2026-07-12T10:02:00.000Z",
      branch: "factory/build",
      commit: "abc123",
      checks: ["npm test"],
    },
  },
};

test("aggregates objective and task operator state", () => {
  const dashboard = aggregateDashboard({
    states: [state],
    queue: { active: 2, deadLetter: 1 },
    runtime: { startedAt: "2026-07-12T09:00:00.000Z", status: "running" },
    hostUptimeSeconds: 7200,
    now: new Date("2026-07-12T10:03:00.000Z"),
  });

  assert.deepEqual(dashboard.summary.objectives, { running: 1 });
  assert.equal(dashboard.queue.deadLetter, 1);
  assert.equal(dashboard.worker.uptimeSeconds, 3780);
  assert.equal(dashboard.objectives[0].tasks[0].model, "azureai-textved/factory-kimi-k2-7-code");
  assert.equal(dashboard.objectives[0].tasks[1].state, "ready");
  assert.deepEqual(dashboard.objectives[0].checks, ["build-one: npm test"]);
});

test("loads month-to-date Azure cost grouped by service", async () => {
  const cost = await loadAzureCost({ subscriptionId: "sub", resourceGroup: "rg" }, {
    credential: { getToken: async () => ({ token: "token" }) },
    fetch: async () => ({ ok: true, json: async () => ({ properties: {
      columns: [{ name: "Cost" }, { name: "ResourceType" }, { name: "Currency" }],
      rows: [[12.5, "Microsoft.Compute/virtualMachines", "USD"], [2.25, "Microsoft.ServiceBus/namespaces", "USD"]],
    } }) }),
  });
  assert.deepEqual(cost, { monthToDate: 14.75, currency: "USD", byService: { "Microsoft.Compute/virtualMachines": 12.5, "Microsoft.ServiceBus/namespaces": 2.25 } });
});

test("loads active and dead-letter counts across all durable queues", async () => {
  const metrics = await loadQueueMetrics({ serviceBusFqdn: "factory.servicebus.windows.net", controlQueue: "control", agentQueue: "agents", releaseQueue: "release" }, {
    createAdmin: () => ({ getQueueRuntimeProperties: async (name) => ({ activeMessageCount: name === "agents" ? 2 : 1, deadLetterMessageCount: name === "control" ? 3 : 0 }) }),
  });
  assert.deepEqual(metrics, { active: 4, deadLetter: 3 });
});

test("loads valid state while recording corrupt and partial files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-dashboard-"));
  await mkdir(path.join(root, "good"));
  await mkdir(path.join(root, "bad"));
  await writeFile(path.join(root, "good", "state.json"), JSON.stringify(state));
  await writeFile(path.join(root, "bad", "state.json"), "{broken");

  const loaded = await loadLocalState(root);

  assert.equal(loaded.states.length, 1);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /bad\/state\.json/);
});

test("renders narrow terminals safely and emits deterministic JSON", () => {
  const dashboard = aggregateDashboard({ states: [state], now: new Date("2026-07-12T10:03:00.000Z") });
  const rendered = renderDashboard(dashboard, { width: 40, color: false });

  assert.match(rendered, /AGENT FACTORY/);
  assert.match(rendered, /builder/);
  assert.ok(rendered.split("\n").every((line) => line.length <= 40));
  assert.equal(stableStringify({ z: 1, a: { y: 2, b: 3 } }), '{"a":{"b":3,"y":2},"z":1}\n');
  assert.equal(humanDuration(3661), "1h 1m");
});
