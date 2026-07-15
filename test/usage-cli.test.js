import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsageRecords } from "../src/usage-record.js";
import { readLocalUsage, usageReport, writeLocalUsage } from "../src/usage-cli.js";

function record(model, input, output, cache = 0) {
  return createUsageRecords([{ objective: { id: `o${input}` }, tasks: [{ id: "task", role: "builder" }], results: { task: { status: "succeeded", commit: String(input).padStart(40, "a"), completedAt: `2026-07-15T10:${String(input).padStart(2, "0")}:00.000Z`, telemetry: { model, usage: { inputTokens: input, outputTokens: output, cachedInputTokens: cache } } } } }])[0];
}

test("writes, deduplicates, reads, and reports the local Factory AI ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-usage-"));
  const first = record("azure/gpt", 10, 2, 3);
  const second = record("bedrock/model", 20, 4);
  await writeLocalUsage(root, [first, second, first]);
  const records = await readLocalUsage(root);
  assert.deepEqual(records.map((item) => item.recordId), [first, second].map((item) => item.recordId));
  assert.deepEqual(usageReport(records), [
    { model: "bedrock/model", requests: 1, inputTokens: 20, cacheReadInputTokens: 0, outputTokens: 4 },
    { model: "azure/gpt", requests: 1, inputTokens: 10, cacheReadInputTokens: 3, outputTokens: 2 },
  ]);
});
