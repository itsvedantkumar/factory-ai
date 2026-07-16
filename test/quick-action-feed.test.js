import test from "node:test";
import assert from "node:assert/strict";
import { createQuickActionFeedPublisher, publishQuickActionFeed } from "../src/quick-action-feed.js";

test("publishes a bounded projected quick-action feed", async () => {
  const uploaded = [];
  const states = Array.from({ length: 105 }, (_, index) => ({
    action: {
      id: `action-${String(index).padStart(3, "0")}`,
      kind: "prompt",
      prompt: index === 104 ? "Use authorization: Bearer abcdefghijklmnopqrstuvwxyz" : `Prompt ${index}`,
      workspace: "app",
      repository: "https://user:secret@example.invalid/private.git",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    },
    status: index === 104 ? "succeeded" : "queued",
    result: index === 104 ? { summary: "Found ghp_abcdefghijklmnopqrstuvwxyz123456", checks: [], risks: [] } : undefined,
  }));

  await publishQuickActionFeed({ storageAccount: "account" }, states, {
    now: new Date("2026-01-02T00:00:00.000Z"),
    upload: async (_config, name, value, contentType) => uploaded.push({ name, value: JSON.parse(value), contentType }),
  });

  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].name, "quick-actions.json");
  assert.equal(uploaded[0].contentType, "application/json; charset=utf-8");
  assert.equal(uploaded[0].value.actions.length, 100);
  assert.equal(uploaded[0].value.actions[0].id, "action-005");
  assert.match(uploaded[0].value.actions.at(-1).prompt, /authorization: \[REDACTED\]/);
  assert.equal(uploaded[0].value.actions.at(-1).summary, "Found [REDACTED]");
  assert.doesNotMatch(JSON.stringify(uploaded[0].value), /repository|super-secret|abcdefghijklmnopqrstuvwxyz/);
});

test("redacts credential variants from the action feed", async () => {
  const uploaded = [];
  const secrets = [
    "AZURE_CLIENT_SECRET=azure-value",
    "Authorization: Basic dXNlcjpwYXNz",
    "https://user:password@example.com/private.git",
    "bot123456:abcdefghijklmnopqrstuvwxyz123456",
  ].join(" ");
  await publishQuickActionFeed({ storageAccount: "account" }, [{
    action: { id: "action-secret", kind: "prompt", prompt: secrets, workspace: "app", createdAt: "2026-01-01T00:00:00Z" },
    status: "failed",
    failure: secrets,
  }], { upload: async (_config, _name, value) => uploaded.push(value) });
  assert.doesNotMatch(uploaded[0], /azure-value|dXNlcjpwYXNz|user:password|abcdefghijklmnopqrstuvwxyz123456/);
});

test("reports a failed operator upload", async () => {
  await assert.rejects(
    publishQuickActionFeed({ storageAccount: "account" }, [], { upload: async () => false }),
    /upload/i,
  );
});

test("serializes feed writes and retries after an upload failure", async () => {
  let status = "queued";
  let attempts = 0;
  const observed = [];
  const publish = createQuickActionFeedPublisher({ storageAccount: "account" }, {
    loadStates: async () => [{ action: { id: "action-1", prompt: "Audit", createdAt: "2026-01-01T00:00:00Z" }, status }],
    upload: async (_config, _name, value) => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary outage");
      observed.push(JSON.parse(value).actions[0].status);
    },
  });

  await assert.rejects(publish(), /temporary outage/);
  status = "succeeded";
  await Promise.all([publish(), publish()]);
  assert.deepEqual(observed, ["succeeded", "succeeded"]);
});

test("aborts a stalled feed upload", async () => {
  const publish = createQuickActionFeedPublisher({ storageAccount: "account" }, {
    loadStates: async () => [],
    timeoutMs: 10,
    upload: async (_config, _name, _value, _contentType, { abortSignal }) => new Promise((resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    }),
  });
  await assert.rejects(publish(), /timed out/i);
});
