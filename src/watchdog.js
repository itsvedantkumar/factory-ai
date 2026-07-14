#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
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

export function findExpiredApprovals(states, now = new Date()) {
  return states.filter((state) => state.status === "approval_required" && state.approval?.status === "approval_required" && Date.parse(state.approval.expiresAt) <= now.getTime()).map((state) => ({
    type: "approval_decision",
    objectiveId: state.objective.id,
    approvalId: state.approval.approvalId,
    decision: "expired",
    actor: "approval-timeout",
    reason: `Approval expired at ${state.approval.expiresAt}`,
    decidedAt: now.toISOString(),
    messageId: `expiry-${createHash("sha256").update(`${state.objective.id}\0${state.approval.approvalId}\0${state.approval.expiresAt}`).digest("hex").slice(0, 32)}`,
  }));
}

async function main() {
  const config = loadConfig();
  const { states } = await loadLocalState(config.stateDir);
  const now = new Date();
  const stale = findStaleAgents(states, now, Number(process.env.FACTORY_WATCHDOG_STALE_SECONDS ?? 900));
  const expired = findExpiredApprovals(states, now);
  if (stale.length === 0 && expired.length === 0) return;
  const client = new ServiceBusClient(config.serviceBusFqdn, new DefaultAzureCredential());
  const sender = client.createSender(config.controlQueue);
  const activityStore = new ActivityStore(config.stateDir);
  try {
    for (const decision of expired) await sendMessage(sender, decision, decision.messageId, decision.objectiveId);
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
