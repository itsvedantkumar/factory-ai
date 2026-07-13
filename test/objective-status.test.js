import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { objectiveIsTerminal } from "../src/objective-status.js";

test("detects terminal objective state before redelivered agent work", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-objective-"));
  await mkdir(path.join(root, "objective1"));
  await writeFile(path.join(root, "objective1", "state.json"), JSON.stringify({ status: "failed" }));
  assert.equal(await objectiveIsTerminal(root, "objective1"), true);
  assert.equal(await objectiveIsTerminal(root, "missing"), false);
  assert.equal(await objectiveIsTerminal(root, "../escape"), false);
});

test("treats denied and expired approvals as terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-objective-"));
  for (const status of ["denied", "expired"]) {
    await mkdir(path.join(root, status));
    await writeFile(path.join(root, status, "state.json"), JSON.stringify({ status }));
    assert.equal(await objectiveIsTerminal(root, status), true);
  }
});
