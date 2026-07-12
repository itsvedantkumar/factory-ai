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

const config = loadConfig();
Object.assign(process.env, await loadRuntimeSecrets(config));
await run("gh", ["auth", "setup-git"], { timeoutMs: 60_000 });
const bus = createBus(config, config.agentQueue, config.controlQueue);
const executor = new AgentExecutor({
  workspaces: new WorkspaceManager(config.workspaceDir, config.timeoutMs),
  agentRunner: new ContainerAgentRunner({ image: config.workerImage, memoryDir: config.memoryDir, timeoutMs: config.timeoutMs }),
  sendControl: (message) => sendMessage(bus.sender, message, `${message.objectiveId}:${message.type}:${message.taskId ?? "plan"}:${Date.now()}`, message.objectiveId),
});

let shuttingDown = false;
const subscription = bus.receiver.subscribe({
  processMessage: async (message) => {
    const body = message.body;
    try {
      await executor.process(body);
      await bus.receiver.completeMessage(message);
    } catch (error) {
      log("error", "message_failed", {
        messageId: String(message.messageId),
        type: body?.type,
        deliveryCount: message.deliveryCount,
        error: error.message,
      });
      if (message.deliveryCount >= config.maxDeliveryCount) {
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
