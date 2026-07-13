#!/usr/bin/env node
import { aggregateDashboard, loadAzureCost, loadLocalState, loadQueueMetrics } from "./dashboard.js";
import { loadConfig } from "./config.js";
import { uploadDashboardSnapshot } from "./reporter.js";

process.title = "factory-ai-snapshot";
const config = loadConfig();
const root = process.env.FACTORY_STATE_DIR ?? "/opt/agent-factory/state";
const loaded = await loadLocalState(root);
const queue = await loadQueueMetrics(config);
let cost = null;
try { cost = await loadAzureCost(config); } catch (error) { loaded.warnings.push(`Cost unavailable: ${error.message}`); }
const dashboard = aggregateDashboard({ ...loaded, queue, cost, runtime: { status: "running" } });
await uploadDashboardSnapshot(config, dashboard);
process.stdout.write(`${JSON.stringify({ event: "dashboard_snapshot", generatedAt: dashboard.generatedAt })}\n`);
