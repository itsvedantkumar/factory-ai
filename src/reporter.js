#!/usr/bin/env node
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateDashboard, loadLocalState, stableStringify } from "./dashboard.js";

function markdown(dashboard) {
  const objectives = Object.entries(dashboard.summary.objectives).map(([state, count]) => `${state}=${count}`).join(", ") || "none";
  return `# Agent Factory Hourly Report\n\nGenerated: ${dashboard.generatedAt}\n\nQueue: ${dashboard.queue.active} active, ${dashboard.queue.deadLetter} dead-letter\n\nObjectives: ${objectives}\n`;
}

async function atomicWrite(file, content) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, content, { mode: 0o640 });
  await rename(temporary, file);
}

export async function writeHourlyReport(root, dashboard, { now = new Date(), retention = 168 } = {}) {
  const reports = path.join(root, "reports");
  await mkdir(reports, { recursive: true, mode: 0o750 });
  const stem = now.toISOString().slice(0, 13);
  await atomicWrite(path.join(reports, `${stem}.json`), stableStringify(dashboard));
  await atomicWrite(path.join(reports, `${stem}.md`), markdown(dashboard));
  const stems = [...new Set((await readdir(reports)).filter((name) => /^\d{4}-\d{2}-\d{2}T\d{2}\.(json|md)$/.test(name)).map((name) => name.slice(0, 13)))].sort();
  for (const expired of stems.slice(0, Math.max(0, stems.length - retention))) {
    await Promise.all(["json", "md"].map((extension) => rm(path.join(reports, `${expired}.${extension}`), { force: true })));
  }
  return stem;
}

async function main() {
  const root = process.env.FACTORY_STATE_DIR ?? "/opt/agent-factory/state";
  const loaded = await loadLocalState(root);
  const dashboard = aggregateDashboard({ ...loaded, runtime: { status: "running" } });
  const stem = await writeHourlyReport(root, dashboard);
  process.stdout.write(`${JSON.stringify({ event: "hourly_report", report: stem })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
