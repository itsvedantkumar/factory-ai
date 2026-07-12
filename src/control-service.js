#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBus, sendMessage } from "./bus.js";
import { StateStore } from "./state.js";
import { ControlPlane } from "./control-plane.js";
import { loadRegistry } from "./registry.js";
import { log } from "./log.js";

const config = loadConfig();
const bus = createBus(config, config.controlQueue, config.agentQueue);
const releaseSender = bus.client.createSender(config.releaseQueue);
const control = new ControlPlane({
  store: new StateStore(config.stateDir),
  registry: await loadRegistry(config.registryPath),
  sendTask: (message) => sendMessage(bus.sender, message, `${message.objectiveId}:${message.task.id}:v1`, message.objectiveId),
  sendRelease: (message) => sendMessage(releaseSender, message, `${message.objectiveId}:publish:v1`, message.objectiveId),
});

let shuttingDown = false;
const subscription = bus.receiver.subscribe({
  processMessage: async (message) => {
    try {
      if (message.body?.type === "objective") await control.acceptObjective(message.body);
      else if (message.body?.type === "planning_result") await control.acceptPlanningResult(message.body);
      else if (message.body?.type === "result") await control.acceptTaskResult(message.body);
      else if (message.body?.type === "release_result") await control.acceptReleaseResult(message.body);
      else throw new Error(`Unsupported control message type: ${message.body?.type}`);
      await bus.receiver.completeMessage(message);
    } catch (error) {
      log("error", "control_message_failed", { messageId: String(message.messageId), deliveryCount: message.deliveryCount, error: error.message });
      if (message.deliveryCount >= config.maxDeliveryCount) {
        await bus.receiver.deadLetterMessage(message, { deadLetterReason: "MaxDeliveryExceeded", deadLetterErrorDescription: error.message.slice(0, 4096) });
      } else await bus.receiver.abandonMessage(message);
    }
  },
  processError: async ({ error, errorSource }) => log("error", "control_bus_error", { source: errorSource, error: error.message }),
}, { autoCompleteMessages: false, maxConcurrentCalls: 1, maxAutoLockRenewalDurationInMs: 300_000 });

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("info", "control_shutdown", { signal });
  await subscription.close();
  await bus.receiver.close();
  await bus.sender.close();
  await releaseSender.close();
  await bus.client.close();
}

process.once("SIGTERM", () => shutdown("SIGTERM").catch((error) => log("error", "control_shutdown_failed", { error: error.message })));
process.once("SIGINT", () => shutdown("SIGINT").catch((error) => log("error", "control_shutdown_failed", { error: error.message })));
log("info", "control_started", { queue: config.controlQueue });
