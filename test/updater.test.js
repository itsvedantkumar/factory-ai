import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, shouldAutoUpdate } from "../src/updater.js";

test("compares semantic versions", () => {
  assert.equal(compareVersions("1.2.0", "1.1.9"), 1);
  assert.equal(compareVersions("1.1.0", "1.1.0"), 0);
  assert.equal(compareVersions("1.0.9", "1.1.0"), -1);
});

test("allows stable patch and minor updates but blocks major changes", () => {
  assert.equal(shouldAutoUpdate("1.0.0", "1.0.1"), true);
  assert.equal(shouldAutoUpdate("1.0.0", "1.2.0"), true);
  assert.equal(shouldAutoUpdate("1.0.0", "2.0.0"), false);
  assert.equal(shouldAutoUpdate("1.2.0", "1.1.0"), false);
});
