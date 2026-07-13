#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBus } from "./bus.js";
import { WorkspaceManager } from "./workspace.js";
import { log } from "./log.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { run } from "./process.js";
import { AgentExecutor } from "./agent-executor.js";
import { sendMessage } from "./bus.js";
import { ContainerAgentRunner } from "./container-runner.js";
import { ScannerSuite } from "./scanner-suite.js";
import { LocalRetriever } from "./retriever.js";
import { ActivityStore } from "./activity.js";
import { objectiveIsTerminal } from "./objective-status.js";
import { evaluateApprovalPolicy } from "./approval-policy.js";

process.title = "factory-ai-worker";
const config = loadConfig();
Object.assign(process.env, await loadRuntimeSecrets(config));
await run("gh", ["auth", "setup-git"], { timeoutMs: 60_000 });
const bus = createBus(config, config.agentQueue, config.controlQueue);
const sendControl = (message) => sendMessage(bus.sender, message, `${message.objectiveId}:${message.type}:${message.approvalId ?? message.taskId ?? "plan"}:v1`, message.objectiveId);
const scannerSuite = new ScannerSuite();
async function requestApproval(input, context) {
  if (context.message.approvalGranted) return { skipped: true };
  const now = new Date();
  const approvalId = `approval-${context.message.task.id}`.slice(0, 64);
  await sendControl({ type: "approval_request", objectiveId: context.message.objectiveId, approvalId, policy: input.policy, reason: input.reason, actor: "factory-policy", requestedAt: now.toISOString(), expiresAt: input.expiresAt ?? new Date(now.getTime() + 86_400_000).toISOString(), checkpoint: context.message.task.id });
  return { approvalId };
}
const executor = new AgentExecutor({
  workspaces: new WorkspaceManager(config.workspaceDir, config.timeoutMs),
  agentRunner: new ContainerAgentRunner({ image: config.workerImage, memoryDir: config.memoryDir, timeoutMs: config.timeoutMs, activityStore: new ActivityStore(config.stateDir) }),
  scannerSuite,
  retriever: new LocalRetriever({ stateDir: config.stateDir }),
  repoMapMaxCharacters: config.repoMapMaxCharacters,
  sendControl,
  hooks: config.hooks,
  hookHandlers: {
    scanner: (input, context) => scannerSuite.scan(context.directory, { names: input.scanners }),
    policy_check: async (input, context) => {
      const evaluated = evaluateApprovalPolicy(Object.fromEntries(input.policies.map((policy) => [policy, new RegExp(policy.replaceAll("_", ".*"), "i").test(`${context.message.task.title} ${context.message.task.instructions}`)])));
      if (!evaluated.required) return evaluated;
      return { ...evaluated, ...await requestApproval({ policy: evaluated.policies[0], reason: `Policy requires approval: ${evaluated.policies.join(", ")}` }, context) };
    },
    notification: async (input, context) => log("info", "hook_notification", { objectiveId: context.message.objectiveId, taskId: context.message.task.id, message: input.message }),
    snapshot: async (input) => ({ label: input.label ?? "checkpoint" }),
    approval_request: requestApproval,
  },
});

let shuttingDown = false;
const subscription = bus.receiver.subscribe({
  processMessage: async (message) => {
    const body = message.body;
    try {
      if (await objectiveIsTerminal(config.stateDir, body?.objectiveId)) {
        log("info", "terminal_objective_message_discarded", { objectiveId: body.objectiveId, taskId: body.task?.id });
        await bus.receiver.completeMessage(message);
        return;
      }
      await executor.process(body);
      await bus.receiver.completeMessage(message);
    } catch (error) {
      log("error", "message_failed", {
        messageId: String(message.messageId),
        type: body?.type,
        deliveryCount: message.deliveryCount,
        error: error.message,
      });
      const permanent = error.message.includes("content_filter") || message.deliveryCount >= config.maxDeliveryCount;
      if (permanent) {
        await sendControl({
          type: "failure_result",
          objectiveId: body?.objectiveId,
          taskId: body?.task?.id,
          error: String(error.message).slice(0, 2000),
        });
        await bus.receiver.deadLetterMessage(message, {
          deadLetterReason: "MaxDeliveryExceeded",
          deadLetterErrorDescription: String(error.message).slice(0, 4096),
        });
      } else {
        await bus.receiver.abandonMessage(message);
      }
    }
  },
  processError: async ({ error, errorSource }) => {
    log("error", "service_bus_error", { source: errorSource, error: error.message });
  },
}, {
  autoCompleteMessages: false,
  maxConcurrentCalls: config.concurrency,
  maxAutoLockRenewalDurationInMs: (config.timeoutMs * 4) + 300_000,
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "worker_shutdown", { signal });
  await subscription.close();
  await bus.receiver.close();
  await bus.sender.close();
  await bus.client.close();
}

process.once("SIGTERM", () => shutdown("SIGTERM").catch((error) => log("error", "shutdown_failed", { error: error.message })));
process.once("SIGINT", () => shutdown("SIGINT").catch((error) => log("error", "shutdown_failed", { error: error.message })));
log("info", "worker_started", { concurrency: config.concurrency, queue: config.agentQueue });
