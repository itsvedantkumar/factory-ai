#!/usr/bin/env node
import { aggregateDashboard, loadAzureCost, loadLocalState, loadQueueMetrics } from "./dashboard.js";
import { loadConfig } from "./config.js";
import { uploadDashboardSnapshot } from "./reporter.js";
import { uploadOperatorBlob } from "./reporter.js";
import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import { run } from "./process.js";
import { safeOperatorLogs } from "./operator-logs.js";

process.title = "factory-ai-snapshot";
const config = loadConfig();
const root = process.env.FACTORY_STATE_DIR ?? "/opt/agent-factory/state";
const loaded = await loadLocalState(root);
const queue = await loadQueueMetrics(config);
let cost = null;
try { cost = await loadAzureCost(config); } catch (error) { loaded.warnings.push(`Cost unavailable: ${error.message}`); }
const dashboard = aggregateDashboard({ ...loaded, queue, cost, runtime: { status: "running" } });
try {
  const secrets = [];
  const client = new SecretClient(config.keyVaultUrl, new DefaultAzureCredential());
  for await (const item of client.listPropertiesOfSecrets()) secrets.push({ name: item.name, updated: item.updatedOn?.toISOString() });
  dashboard.secrets = secrets.sort((left, right) => left.name.localeCompare(right.name));
} catch (error) { dashboard.warnings.push(`Secret metadata unavailable: ${error.message}`); }
try {
  const result = await run("journalctl", ["-o", "cat", "-u", "agent-factory-control", "-u", "agent-factory-worker", "-u", "agent-factory-release", "-u", "agent-factory-telegram", "--since", "1 hour ago", "--no-pager", "-n", "500"], { timeoutMs: 30_000, maxOutputBytes: 500_000 });
  const logs = safeOperatorLogs(result.stdout);
  await uploadOperatorBlob(config, "logs.txt", logs);
} catch (error) { dashboard.warnings.push(`Log snapshot unavailable: ${error.message}`); }
await uploadDashboardSnapshot(config, dashboard);
process.stdout.write(`${JSON.stringify({ event: "dashboard_snapshot", generatedAt: dashboard.generatedAt })}\n`);
