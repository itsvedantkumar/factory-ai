import test from "node:test";
import assert from "node:assert/strict";
import { compactCheckpoint } from "../src/context-compaction.js";

test("compacts execution history into a bounded checkpoint with recent evidence", () => {
  const checkpoint = compactCheckpoint(`skill text ${"x".repeat(1000)}`, [
    { tool: "read_file", output: "old ".repeat(500) },
    { tool: "run_command", output: "tests passed" },
  ], { maxCharacters: 500, immutableContext: "Implement the feature without changing the API" });

  assert.match(checkpoint, /Implement the feature/);
  assert.match(checkpoint, /without changing the API/);
  assert.match(checkpoint, /run_command: tests passed/);
  assert.ok(checkpoint.length <= 500);
});
