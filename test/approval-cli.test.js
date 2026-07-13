import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("approval CLI rejects identifiers the control plane cannot consume", () => {
  const result = spawnSync(process.execPath, ["src/approval-cli.js", "approve", "_objective", "approval1", "reason"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: factory approval/);
});
