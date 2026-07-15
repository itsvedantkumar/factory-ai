#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { modelForTask } from "./routing.js";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusAdministrationClient } from "@azure/service-bus";
import { loadConfig } from "./config.js";
import { ActivityStore, isStaleActivity } from "./activity.js";

export async function loadQueueMetrics(config, {
  createAdmin = () => new ServiceBusAdministrationClient(config.serviceBusFqdn, new DefaultAzureCredential()),
} = {}) {
  const admin = createAdmin();
  const properties = await Promise.all([config.controlQueue, config.agentQueue, config.releaseQueue].map((queue) => admin.getQueueRuntimeProperties(queue)));
  return {
    active: properties.reduce((total, item) => total + (item.activeMessageCount ?? 0), 0),
    deadLetter: properties.reduce((total, item) => total + (item.deadLetterMessageCount ?? 0), 0),
  };
}

export async function loadAzureCost(config, { credential = new DefaultAzureCredential(), fetch = globalThis.fetch } = {}) {
  if (!config.subscriptionId || !config.resourceGroup) return null;
  const access = await credential.getToken("https://management.azure.com/.default");
  const scope = `/subscriptions/${config.subscriptionId}/resourceGroups/${config.resourceGroup}`;
  const response = await fetch(`https://management.azure.com${scope}/providers/Microsoft.CostManagement/query?api-version=2025-03-01`, {
    method: "POST",
    headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      type: "ActualCost",
      timeframe: "MonthToDate",
      dataset: {
        granularity: "None",
        aggregation: { totalCost: { name: "Cost", function: "Sum" } },
        grouping: [{ type: "Dimension", name: "ResourceType" }],
      },
    }),
  });
  if (!response.ok) throw new Error(`Azure Cost Management HTTP ${response.status}`);
  const result = await response.json();
  const columns = result.properties?.columns?.map((column) => column.name) ?? [];
  const costIndex = columns.indexOf("Cost");
  const serviceIndex = columns.indexOf("ResourceType");
  const currencyIndex = columns.indexOf("Currency");
  const byService = {};
  let monthToDate = 0;
  let currency = "USD";
  for (const row of result.properties?.rows ?? []) {
    const amount = Number(row[costIndex] ?? 0);
    monthToDate += amount;
    byService[row[serviceIndex] ?? "Other"] = amount;
    currency = row[currencyIndex] ?? currency;
  }
  return { monthToDate, currency, byService };
}

export function humanDuration(seconds) {
  const value = Math.max(0, Math.floor(seconds ?? 0));
  if (value >= 3600) return `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`;
  if (value >= 60) return `${Math.floor(value / 60)}m ${value % 60}s`;
  return `${value}s`;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortObject(value[key])]));
  return value;
}

export function stableStringify(value) {
  return `${JSON.stringify(sortObject(value))}\n`;
}

export async function loadLocalState(root) {
  const states = [];
  const warnings = [];
  const activityStore = new ActivityStore(root);
  let directories = [];
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const infrastructureDirectories = new Set(["activity", "home", "memory", "ollama", "qdrant", "qdrant-snapshots", "reports", "retrieval", "telegram"]);
  for (const entry of directories.filter((item) => item.isDirectory() && !infrastructureDirectories.has(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, "state.json");
    try {
      const state = JSON.parse(await readFile(file, "utf8"));
      state.activity = await activityStore.latestObjective(state.objective?.id ?? entry.name);
      state.activityTimeline = await activityStore.timelineObjective(state.objective?.id ?? entry.name);
      states.push(state);
    } catch (error) {
      if (error.code !== "ENOENT") warnings.push(`${file}: ${error.message}`);
    }
  }
  return { states, warnings };
}

function taskState(task, results) {
  if (results[task.id]?.status) return results[task.id].status;
  return task.dependsOn.every((id) => results[id]?.status === "succeeded") ? "ready" : "blocked";
}

export function aggregateDashboard({ states = [], queue = {}, cost = null, runtime = {}, hostUptimeSeconds = 0, warnings = [], now = new Date(), factoryName = process.env.FACTORY_NAME ?? "Factory AI" }) {
  let remainingActivityEvents = 1000;
  const objectives = states.map((state) => {
    const results = state.results ?? {};
    const objectiveTerminal = ["complete", "failed", "blocked", "cancelled", "denied", "expired"].includes(state.status);
    const plannedTasks = state.tasks?.length ? state.tasks : state.status === "planning" ? [{ id: "planner0", role: "planner", title: "Create delivery graph", dependsOn: [], complexity: "complex" }] : [];
    const tasks = plannedTasks.map((task) => {
      const resultState = taskState(task, results);
      const liveActivity = state.activity?.[task.id];
      const activity = liveActivity ?? ((resultState === "queued" || state.status === "planning") ? { type: "task.queued", occurredAt: results[task.id]?.queuedAt ?? state.createdAt } : undefined);
      const stateValue = resultState === "queued" && liveActivity ? (liveActivity.type?.endsWith(".failed") ? "retrying" : "running") : resultState;
      const eventLimit = Math.min(50, remainingActivityEvents);
      const retainedEvents = eventLimit > 0 ? (state.activityTimeline?.[task.id] ?? []).slice(-eventLimit) : [];
      const stale = !objectiveTerminal && isStaleActivity(activity, stateValue, now, liveActivity ? 120 : 600);
      remainingActivityEvents = Math.max(0, remainingActivityEvents - retainedEvents.length);
      return ({
      id: task.id,
      role: task.role,
      title: task.title,
      model: modelForTask(task),
      state: stateValue,
      branch: results[task.id]?.branch,
      commit: results[task.id]?.commit,
      elapsedSeconds: results[task.id]?.startedAt
        ? (new Date(results[task.id]?.completedAt ?? now).getTime() - new Date(results[task.id].startedAt).getTime()) / 1000
        : 0,
      activity,
      stale,
      activityAgeSeconds: activity?.occurredAt ? Math.max(0, (now.getTime() - new Date(activity.occurredAt).getTime()) / 1000) : null,
      retries: activity?.retryCount ?? 0,
      lastError: stale || ["failed", "retrying"].includes(stateValue) ? results[task.id]?.error ?? activity?.lastError : undefined,
      events: retainedEvents,
    });
    });
    return {
      id: state.objective?.id,
      objective: state.objective?.objective,
      repository: state.objective?.repository,
      status: state.status,
      tasks,
      checks: Object.entries(results).flatMap(([id, result]) => (result.checks ?? []).map((check) => `${id}: ${check}`)),
      blocker: state.failure,
      pullRequest: state.release?.url ?? Object.values(results).map((result) => result.release?.url).find(Boolean),
      approval: state.approval ? { approvalId: state.approval.approvalId, status: state.approval.status, policy: state.approval.policy, reason: state.approval.reason, expiresAt: state.approval.expiresAt } : undefined,
    };
  });
  const summary = {};
  for (const objective of objectives) summary[objective.status ?? "unknown"] = (summary[objective.status ?? "unknown"] ?? 0) + 1;
  const modelUsage = {};
  for (const state of states) {
    for (const result of Object.values(state.results ?? {})) {
      const telemetry = result.telemetry;
      if (!telemetry?.model) continue;
      const current = modelUsage[telemetry.model] ?? { tasks: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, durationMs: 0 };
      current.tasks += 1;
      current.inputTokens += telemetry.usage?.inputTokens ?? 0;
      current.cachedInputTokens += telemetry.usage?.cachedInputTokens ?? 0;
      current.outputTokens += telemetry.usage?.outputTokens ?? 0;
      current.durationMs += telemetry.durationMs ?? 0;
      modelUsage[telemetry.model] = current;
    }
  }
  const startedAt = runtime.startedAt ? new Date(runtime.startedAt) : null;
  const staleAgents = objectives.flatMap((objective) => objective.tasks).filter((task) => task.stale).length;
  return {
    factoryName,
    generatedAt: now.toISOString(),
    worker: {
      status: runtime.status ?? "unknown",
      uptimeSeconds: startedAt ? Math.max(0, (now.getTime() - startedAt.getTime()) / 1000) : hostUptimeSeconds,
    },
    queue: { active: queue.active ?? 0, deadLetter: queue.deadLetter ?? 0 },
    health: { status: staleAgents > 0 || (queue.deadLetter ?? 0) > 0 ? "degraded" : "healthy", staleAgents },
    cost,
    summary: { objectives: summary },
    modelUsage,
    objectives,
    warnings,
  };
}

function clip(value, width) {
  const text = String(value ?? "");
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

export function renderDashboard(dashboard, { width = 100 } = {}) {
  const lines = [
    `╔═ ${(dashboard.factoryName ?? "Factory AI").toUpperCase()} ═╗`,
    `Worker ${dashboard.worker.status} · uptime ${humanDuration(dashboard.worker.uptimeSeconds)} · queue ${dashboard.queue.active} · DLQ ${dashboard.queue.deadLetter}`,
    `Objectives ${Object.entries(dashboard.summary.objectives).map(([state, count]) => `${state}:${count}`).join(" ") || "none"}`,
  ];
  if (dashboard.cost) lines.push(`Azure MTD ${dashboard.cost.currency} ${dashboard.cost.monthToDate.toFixed(2)} · billing data may be delayed`);
  const totalInput = Object.values(dashboard.modelUsage ?? {}).reduce((sum, item) => sum + item.inputTokens, 0);
  const totalCached = Object.values(dashboard.modelUsage ?? {}).reduce((sum, item) => sum + item.cachedInputTokens, 0);
  const totalOutput = Object.values(dashboard.modelUsage ?? {}).reduce((sum, item) => sum + item.outputTokens, 0);
  if (totalInput || totalOutput) lines.push(`Tokens input ${totalInput} · cached ${totalCached} · output ${totalOutput}`);
  for (const objective of dashboard.objectives) {
    lines.push("", `[${objective.status}] ${objective.id} ${objective.objective}`);
    for (const task of objective.tasks) lines.push(`  ${(task.stale ? "stale" : task.state).padEnd(9)} ${task.role.padEnd(9)} ${task.model} · ${task.title ?? task.id}${task.retries ? ` · retries ${task.retries}` : ""}`);
    if (objective.pullRequest) lines.push(`  PR ${objective.pullRequest}`);
    if (objective.blocker) lines.push(`  BLOCKED ${objective.blocker}`);
  }
  for (const warning of dashboard.warnings) lines.push(`WARN ${warning}`);
  return lines.map((line) => clip(line, Math.max(20, width))).join("\n");
}

async function main() {
  const root = process.env.FACTORY_STATE_DIR ?? "/opt/agent-factory/state";
  const json = process.argv.includes("--json");
  const loaded = await loadLocalState(root);
  let queue = {};
  let cost = null;
  if (process.env.SERVICE_BUS_NAMESPACE) queue = await loadQueueMetrics(loadConfig());
  if (process.env.AZURE_SUBSCRIPTION_ID) {
    try { cost = await loadAzureCost(loadConfig()); } catch (error) { loaded.warnings.push(`Cost unavailable: ${error.message}`); }
  }
  const dashboard = aggregateDashboard({ ...loaded, queue, cost, runtime: { status: "running" } });
  process.stdout.write(json ? stableStringify(dashboard) : `${renderDashboard(dashboard, { width: process.stdout.columns ?? 100 })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
