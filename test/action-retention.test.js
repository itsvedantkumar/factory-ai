import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pruneActionStates } from "../src/action-retention.js";

test("action retention keeps only the newest bounded valid action states", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-action-retention-"));
  for (let index = 0; index < 3; index++) {
    const directory = path.join(root, `action-${index}`);
    await mkdir(directory);
    await writeFile(path.join(directory, "state.json"), JSON.stringify({ status: "succeeded", createdAt: `2026-07-${10 + index}T00:00:00.000Z` }));
  }
  await pruneActionStates(root, { maxEntries: 2, now: new Date("2026-07-15T00:00:00.000Z"), maxAgeMs: 30 * 86400_000 });
  assert.deepEqual((await readdir(root)).sort(), ["action-1", "action-2"]);
});
