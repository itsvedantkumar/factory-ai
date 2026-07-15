import test from "node:test";
import assert from "node:assert/strict";
import { createUsageRecords, parseUsageRecord } from "../src/usage-record.js";

test("creates deterministic privacy-safe Factory AI usage records from provider telemetry", () => {
  const states = [{
    objective: { id: "objective1", repository: "https://github.com/private/repo.git", objective: "secret prompt" },
    tasks: [{ id: "build", role: "builder" }],
    results: { build: { status: "succeeded", commit: "a".repeat(40), completedAt: "2026-07-15T10:00:00.000Z", telemetry: { model: "azureai-textved/gpt-5.5", usage: { inputTokens: 100, cachedInputTokens: 40, outputTokens: 20 } } } },
  }];
  const [record] = createUsageRecords(states);
  assert.equal(record.schemaVersion, "factory.usage.v1");
  assert.equal(record.source, "factory-ai");
  assert.equal(record.provider, "azureai-textved");
  assert.equal(record.model, "gpt-5.5");
  assert.deepEqual(record.usage, { inputTokens: 100, cacheReadInputTokens: 40, outputTokens: 20 });
  assert.equal(createUsageRecords(states)[0].recordId, record.recordId);
  assert.doesNotMatch(JSON.stringify(record), /private|secret prompt|repository|objective1|"build"/);
  assert.deepEqual(parseUsageRecord(record), record);
});

test("rejects usage records containing content or invalid token counts", () => {
  const valid = createUsageRecords([{ objective: { id: "o" }, tasks: [{ id: "t", role: "tester" }], results: { t: { status: "succeeded", commit: "b".repeat(40), completedAt: "2026-07-15T10:00:00.000Z", telemetry: { model: "bedrock/model", usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 } } } } }])[0];
  assert.throws(() => parseUsageRecord({ ...valid, prompt: "no" }));
  assert.throws(() => parseUsageRecord({ ...valid, usage: { ...valid.usage, inputTokens: -1 } }));
});
