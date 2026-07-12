import test from "node:test";
import assert from "node:assert/strict";
import { ReleaseBot } from "../src/release-bot.js";

test("publishes an approved branch and emits a durable release result", async () => {
  const emitted = [];
  const bot = new ReleaseBot({
    checkout: async () => "/tmp/release",
    publisher: { publish: async () => ({ url: "https://github.com/acme/app/pull/1", checks: [], autoMergeEnabled: true, blockers: [] }) },
    sendControl: async (message) => emitted.push(message),
  });
  await bot.process({
    type: "publish_request",
    objectiveId: "objective1",
    objective: { id: "objective1", repository: "https://github.com/acme/app.git", baseBranch: "main" },
    branch: "agent-factory/objective1/release0",
    results: {},
  });
  assert.equal(emitted[0].type, "release_result");
  assert.equal(emitted[0].release.url, "https://github.com/acme/app/pull/1");
});
