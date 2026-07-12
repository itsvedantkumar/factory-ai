import test from "node:test";
import assert from "node:assert/strict";
import { ScannerSuite } from "../src/scanner-suite.js";

test("runs digest-pinned scanners read-only and redacts output", async () => {
  const calls = [];
  const suite = new ScannerSuite({ execute: async (command, args) => {
    calls.push({ command, args });
    return { code: 1, stdout: "api_key=super-secret-value", stderr: "" };
  } });
  const results = await suite.scan("/workspace/task");
  assert.equal(results.length, 4);
  assert.ok(calls.every((call) => call.command === "docker"));
  assert.ok(calls.every((call) => call.args.some((value) => value === "/workspace/task:/workspace:ro")));
  assert.ok(calls.every((call) => call.args.some((value) => value.includes("@sha256:"))));
  assert.ok(results.every((result) => !result.output.includes("super-secret-value")));
});
