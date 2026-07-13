#!/usr/bin/env node
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { aggregateDashboard, loadAzureCost, loadLocalState, loadQueueMetrics, stableStringify } from "./dashboard.js";
import { loadConfig } from "./config.js";
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";

process.title = "factory-ai-reporter";

function markdown(dashboard) {
  const objectives = Object.entries(dashboard.summary.objectives).map(([state, count]) => `${state}=${count}`).join(", ") || "none";
  const cost = dashboard.cost ? `\nAzure month-to-date: ${dashboard.cost.currency} ${dashboard.cost.monthToDate.toFixed(2)} (billing data may be delayed)\n` : "";
  return `# ${process.env.FACTORY_NAME ?? "Factory AI"} Hourly Report\n\nGenerated: ${dashboard.generatedAt}\n\nQueue: ${dashboard.queue.active} active, ${dashboard.queue.deadLetter} dead-letter\n${cost}\nObjectives: ${objectives}\n`;
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

export async function uploadDashboardSnapshot(config, dashboard, {
  credential = new DefaultAzureCredential(),
  createClient = (url, auth) => new BlobServiceClient(url, auth),
} = {}) {
  if (!config.storageAccount) return false;
  const service = createClient(`https://${config.storageAccount}.blob.core.windows.net`, credential);
  const blob = service.getContainerClient("operator").getBlockBlobClient("dashboard.json");
  await blob.uploadData(Buffer.from(stableStringify(dashboard)), {
    blobHTTPHeaders: { blobContentType: "application/json; charset=utf-8", blobCacheControl: "no-store" },
  });
  return true;
}

async function main() {
  const root = process.env.FACTORY_STATE_DIR ?? "/opt/agent-factory/state";
  const config = loadConfig();
  const loaded = await loadLocalState(root);
  const queue = process.env.SERVICE_BUS_NAMESPACE ? await loadQueueMetrics(config) : {};
  let cost = null;
  if (process.env.AZURE_SUBSCRIPTION_ID) {
    try { cost = await loadAzureCost(config); } catch (error) { loaded.warnings.push(`Cost unavailable: ${error.message}`); }
  }
  const dashboard = aggregateDashboard({ ...loaded, queue, cost, runtime: { status: "running" } });
  const stem = await writeHourlyReport(root, dashboard);
  await uploadDashboardSnapshot(config, dashboard);
  process.stdout.write(`${JSON.stringify({ event: "hourly_report", report: stem })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
