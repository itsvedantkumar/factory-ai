import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeHourlyReport } from "../src/reporter.js";

test("writes paired atomic reports and bounds retention by hour", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-reporter-"));
  const dashboard = {
    generatedAt: "2026-07-12T10:15:00.000Z",
    worker: { status: "running", uptimeSeconds: 60 },
    queue: { active: 2, deadLetter: 0 },
    summary: { objectives: { running: 1 } },
    objectives: [],
    warnings: [],
  };

  for (let hour = 8; hour <= 10; hour += 1) {
    await writeHourlyReport(root, dashboard, {
      now: new Date(`2026-07-12T${String(hour).padStart(2, "0")}:15:00.000Z`),
      retention: 2,
    });
  }

  const files = (await readdir(path.join(root, "reports"))).sort();
  assert.deepEqual(files, [
    "2026-07-12T09.json",
    "2026-07-12T09.md",
    "2026-07-12T10.json",
    "2026-07-12T10.md",
  ]);
  assert.doesNotMatch(files.join(" "), /\.tmp/);
  assert.match(await readFile(path.join(root, "reports", "2026-07-12T10.md"), "utf8"), /Queue: 2 active, 0 dead-letter/);
});
