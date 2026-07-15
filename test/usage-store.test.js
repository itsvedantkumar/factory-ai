import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { syncUsageStore } from "../src/usage-store.js";

test("preserves planner and failed-execution provider requests in the durable ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-usage-store-"));
  const activity = path.join(root, "activity", "objective1");
  await mkdir(activity, { recursive: true });
  await writeFile(path.join(activity, "planner0.jsonl"), `${JSON.stringify({ type: "model.request.completed", role: "planner", modelRoute: "azure/gpt", step: 1, occurredAt: "2026-07-15T10:00:00.000Z", usage: { input_tokens: 10, output_tokens: 2 } })}\n${JSON.stringify({ type: "agent.failed", error: "later failure" })}\n`);
  const records = await syncUsageStore(root, "factory-test", [], { now: new Date("2026-07-15T11:00:00.000Z") });
  assert.equal(records.length, 1);
  assert.equal(records[0].role, "planner");
  assert.equal(records[0].usage.inputTokens, 10);
  assert.doesNotMatch(JSON.stringify(records[0]), /objective1|planner0|later failure/);
});

test("recomputes reconciliation records when later request events arrive", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-usage-store-"));
  const activity = path.join(root, "activity", "objective1");
  await mkdir(activity, { recursive: true });
  const event = (step, input) => JSON.stringify({ type: "model.request.completed", role: "builder", modelRoute: "azure/gpt", step, occurredAt: `2026-07-15T10:0${step}:00.000Z`, usage: { input_tokens: input, output_tokens: 1 } });
  await writeFile(path.join(activity, "build.jsonl"), `${event(1, 10)}\n`);
  const states = [{ objective: { id: "objective1" }, tasks: [{ id: "build", role: "builder" }], results: { build: { status: "succeeded", commit: "a".repeat(40), completedAt: "2026-07-15T10:10:00.000Z", telemetry: { model: "azure/gpt", usage: { inputTokens: 30, outputTokens: 2, cachedInputTokens: 0 } } } } }];
  let records = await syncUsageStore(root, "factory-test", states, { now: new Date("2026-07-15T11:00:00.000Z") });
  assert.equal(records.reduce((sum, record) => sum + record.usage.inputTokens, 0), 30);
  await writeFile(path.join(activity, "build.jsonl"), `${event(1, 10)}\n${event(2, 20)}\n`);
  records = await syncUsageStore(root, "factory-test", states, { now: new Date("2026-07-15T11:00:00.000Z") });
  assert.equal(records.reduce((sum, record) => sum + record.usage.inputTokens, 0), 30);
  assert.equal(records.some((record) => record.granularity === "reconciliation"), false);
});
