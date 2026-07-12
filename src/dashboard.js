#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { modelForRole } from "./routing.js";

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
  let directories = [];
  try {
    directories = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of directories.filter((item) => item.isDirectory() && item.name !== "reports").sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name, "state.json");
    try {
      states.push(JSON.parse(await readFile(file, "utf8")));
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

export function aggregateDashboard({ states = [], queue = {}, runtime = {}, hostUptimeSeconds = 0, warnings = [], now = new Date() }) {
  const objectives = states.map((state) => {
    const results = state.results ?? {};
    const tasks = (state.tasks ?? []).map((task) => ({
      id: task.id,
      role: task.role,
      title: task.title,
      model: modelForRole(task.role),
      state: taskState(task, results),
      branch: results[task.id]?.branch,
      commit: results[task.id]?.commit,
      elapsedSeconds: results[task.id]?.startedAt
        ? (new Date(results[task.id]?.completedAt ?? now).getTime() - new Date(results[task.id].startedAt).getTime()) / 1000
        : 0,
    }));
    return {
      id: state.objective?.id,
      objective: state.objective?.objective,
      repository: state.objective?.repository,
      status: state.status,
      tasks,
      checks: Object.entries(results).flatMap(([id, result]) => (result.checks ?? []).map((check) => `${id}: ${check}`)),
      blocker: state.failure,
      pullRequest: Object.values(results).map((result) => result.release?.url).find(Boolean),
    };
  });
  const summary = {};
  for (const objective of objectives) summary[objective.status ?? "unknown"] = (summary[objective.status ?? "unknown"] ?? 0) + 1;
  const startedAt = runtime.startedAt ? new Date(runtime.startedAt) : null;
  return {
    generatedAt: now.toISOString(),
    worker: {
      status: runtime.status ?? "unknown",
      uptimeSeconds: startedAt ? Math.max(0, (now.getTime() - startedAt.getTime()) / 1000) : hostUptimeSeconds,
    },
    queue: { active: queue.active ?? 0, deadLetter: queue.deadLetter ?? 0 },
    summary: { objectives: summary },
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
    "╔═ AGENT FACTORY ═╗",
    `Worker ${dashboard.worker.status} · uptime ${humanDuration(dashboard.worker.uptimeSeconds)} · queue ${dashboard.queue.active} · DLQ ${dashboard.queue.deadLetter}`,
    `Objectives ${Object.entries(dashboard.summary.objectives).map(([state, count]) => `${state}:${count}`).join(" ") || "none"}`,
  ];
  for (const objective of dashboard.objectives) {
    lines.push("", `[${objective.status}] ${objective.id} ${objective.objective}`);
    for (const task of objective.tasks) lines.push(`  ${task.state.padEnd(9)} ${task.role.padEnd(9)} ${task.model} · ${task.title ?? task.id}`);
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
  const dashboard = aggregateDashboard({ ...loaded, runtime: { status: "running" } });
  process.stdout.write(json ? stableStringify(dashboard) : `${renderDashboard(dashboard, { width: process.stdout.columns ?? 100 })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
