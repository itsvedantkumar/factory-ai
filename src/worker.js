#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBus } from "./bus.js";
import { StateStore } from "./state.js";
import { WorkspaceManager } from "./workspace.js";
import { AzureAgentRunner } from "./agent-runner.js";
import { Orchestrator, loadRegistry } from "./orchestrator.js";
import { log } from "./log.js";
import { GitHubRelease } from "./release.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { run } from "./process.js";

const config = loadConfig();
Object.assign(process.env, await loadRuntimeSecrets(config));
await run("gh", ["auth", "setup-git"], { timeoutMs: 60_000 });
const registry = await loadRegistry(config.registryPath);
const bus = createBus(config);
const orchestrator = new Orchestrator({
  store: new StateStore(config.stateDir),
  workspaces: new WorkspaceManager(config.workspaceDir, config.timeoutMs),
  agentRunner: new AzureAgentRunner(config, registry),
  release: new GitHubRelease(config.timeoutMs),
  sender: bus.sender,
});

let shuttingDown = false;
const subscription = bus.receiver.subscribe({
  processMessage: async (message) => {
    const body = message.body;
    try {
      if (body?.type === "objective") await orchestrator.processObjective(body);
      else if (body?.type === "task") await orchestrator.processTask(body);
      else if (body?.type === "result") await orchestrator.processResult(body);
      else throw new Error(`Unsupported message type: ${body?.type}`);
      await bus.receiver.completeMessage(message);
    } catch (error) {
      log("error", "message_failed", {
        messageId: String(message.messageId),
        type: body?.type,
        deliveryCount: message.deliveryCount,
        error: error.message,
      });
      if (message.deliveryCount >= config.maxDeliveryCount) {
        await orchestrator.recordPermanentFailure(body ?? {}, error);
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
log("info", "worker_started", { concurrency: config.concurrency, queue: config.queue });
