import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("control plane has no model, tool, workspace, process, or release capability", async () => {
  const source = await readFile(new URL("../src/control-plane.js", import.meta.url), "utf8");
  for (const forbidden of ["agent-runner", "azure-harness", "workspace", "process.js", "release.js", "child_process", "openCode", ".invoke(", ".plan("]) {
    assert.equal(source.includes(forbidden), false, `control plane contains forbidden capability: ${forbidden}`);
  }
});
