#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ServiceBusClient } from "@azure/service-bus";
import { DefaultAzureCredential } from "@azure/identity";
import { loadConfig } from "./config.js";
import { loadLocalState } from "./dashboard.js";
import { sendMessage } from "./bus.js";
import { run } from "./process.js";
import { ActivityStore } from "./activity.js";
import { objectiveIsTerminal } from "./objective-status.js";

const TERMINAL = new Set(["complete", "failed", "blocked", "cancelled", "denied", "expired"]);

export function findStaleAgents(states, now = new Date(), staleSeconds = 900) {
  const stale = [];
  for (const state of states) {
    if (TERMINAL.has(state.status)) continue;
    const tasks = state.tasks?.length ? state.tasks : state.status === "planning" ? [{ id: "planner0", role: "planner" }] : [];
    for (const task of tasks) {
      if (state.results?.[task.id]?.status !== "queued" && task.id !== "planner0") continue;
      const occurredAt = state.activity?.[task.id]?.occurredAt ?? state.results?.[task.id]?.queuedAt ?? (task.id === "planner0" ? state.createdAt : undefined);
      if (!occurredAt || now.getTime() - new Date(occurredAt).getTime() <= staleSeconds * 1000) continue;
      stale.push({ objectiveId: state.objective.id, taskId: task.id, role: task.role, occurredAt });
    }
  }
  return stale;
}

async function main() {
  const config = loadConfig();
  const { states } = await loadLocalState(config.stateDir);
  const stale = findStaleAgents(states, new Date(), Number(process.env.FACTORY_WATCHDOG_STALE_SECONDS ?? 900));
  if (stale.length === 0) return;
  const client = new ServiceBusClient(config.serviceBusFqdn, new DefaultAzureCredential());
  const sender = client.createSender(config.controlQueue);
  const activityStore = new ActivityStore(config.stateDir);
  try {
    for (const item of stale) {
      await activityStore.withTaskLock(item.objectiveId, item.taskId, async () => {
        const latest = await activityStore.latestTask(item.objectiveId, item.taskId);
        if (await objectiveIsTerminal(config.stateDir, item.objectiveId)) return;
        if (latest?.occurredAt && latest.occurredAt !== item.occurredAt) return;
        await sendMessage(sender, {
          type: "failure_result",
          objectiveId: item.objectiveId,
          taskId: item.taskId,
          error: `Watchdog stopped ${item.role} after no heartbeat since ${item.occurredAt}`,
        }, `watchdog:${item.objectiveId}:${item.taskId}:${item.occurredAt}`, item.objectiveId);
        const container = `factory-ai-${item.objectiveId}-${item.taskId}`.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-").slice(0, 63);
        await run("docker", ["rm", "--force", container], { allowExitCodes: [0, 1], timeoutMs: 30_000 });
      });
    }
  } finally {
    await sender.close();
    await client.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
