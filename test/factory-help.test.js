import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("factory help groups common commands into a readable quick reference", () => {
  const result = spawnSync("bash", ["bin/factory", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const heading of ["GET STARTED", "WORK", "OPERATE", "CONFIGURE", "INTEGRATE"]) {
    assert.match(result.stdout, new RegExp(`^${heading}$`, "m"));
  }
  assert.match(result.stdout, /^  ui\s+Open the interactive operator console$/m);
  assert.match(result.stdout, /^  submit \[--new\] WORKSPACE OBJECTIVE\s+Queue an idempotent objective$/m);
  assert.doesNotMatch(result.stdout, /workspace list \| import/);
  assert.ok(result.stdout.split("\n").length < 65, "help should remain a concise quick reference");
});
