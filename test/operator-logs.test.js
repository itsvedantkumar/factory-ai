import test from "node:test";
import assert from "node:assert/strict";
import { safeOperatorLogs } from "../src/operator-logs.js";

test("operator logs retain allowlisted structured events without credentials", () => {
  const logs = safeOperatorLogs([
    "systemd prefix that is not structured",
    JSON.stringify({ timestamp: "now", level: "error", factory: "Factory AI", service: "factory-ai-worker", event: "failed", error: "token=ghp_abcdefghijklmnopqrstuvwxyz123456", headers: { authorization: "secret" } }),
  ].join("\n"));
  assert.match(logs, /"event":"failed"/);
  assert.doesNotMatch(logs, /ghp_|authorization|headers/);
  assert.match(logs, /\[REDACTED\]/);
  assert.match(logs, /"factory":"Factory AI"/);
  assert.match(logs, /"service":"factory-ai-worker"/);
});
