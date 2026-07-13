import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ActivityStore, isStaleActivity } from "../src/activity.js";

test("appends and reloads latest task activity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-activity-"));
  const store = new ActivityStore(root);
  await store.append("objective-1", "build", { type: "model.request.started", step: 1 });
  await store.append("objective-1", "build", { type: "model.retry", attempt: 1, error: "rate limited" });
  await store.append("objective-1", "build", { type: "tool.completed", tool: "read_file" });
  const latest = await store.latestObjective("objective-1");
  assert.equal(latest.build.type, "tool.completed");
  assert.equal(latest.build.tool, "read_file");
  assert.equal(latest.build.retryCount, 1);
  assert.equal(latest.build.lastError, "rate limited");
});

test("marks old running activity stale but not terminal tasks", () => {
  const now = new Date("2026-01-01T00:05:00Z");
  const old = { occurredAt: "2026-01-01T00:00:00Z" };
  assert.equal(isStaleActivity(old, "running", now, 120), true);
  assert.equal(isStaleActivity(old, "succeeded", now, 120), false);
});

test("serializes watchdog actions and heartbeat appends with a task lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-activity-"));
  const store = new ActivityStore(root);
  const order = [];
  let entered;
  const locked = new Promise((resolve) => { entered = resolve; });
  const watchdog = store.withTaskLock("objective-1", "build", async () => { order.push("watchdog-start"); entered(); await new Promise((resolve) => setTimeout(resolve, 10)); order.push("watchdog-end"); });
  await locked;
  const heartbeat = store.append("objective-1", "build", { type: "agent.heartbeat" }).then(() => order.push("heartbeat"));
  await Promise.all([watchdog, heartbeat]);
  assert.deepEqual(order, ["watchdog-start", "watchdog-end", "heartbeat"]);
});
