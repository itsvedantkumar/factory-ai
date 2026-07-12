#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createBus, sendMessage } from "./bus.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { run } from "./process.js";
import { ReleaseBot } from "./release-bot.js";
import { GitHubRelease } from "./release.js";
import { log } from "./log.js";

const config = loadConfig();
Object.assign(process.env, await loadRuntimeSecrets(config));
await run("gh", ["auth", "setup-git"], { timeoutMs: 60_000 });
const bus = createBus(config, config.releaseQueue, config.controlQueue);
const bot = new ReleaseBot({
  publisher: new GitHubRelease(config.timeoutMs),
  sendControl: (message) => sendMessage(bus.sender, message, `${message.objectiveId}:release-result:v1`, message.objectiveId),
});

const subscription = bus.receiver.subscribe({
  processMessage: async (message) => {
    try {
      await bot.process(message.body);
      await bus.receiver.completeMessage(message);
    } catch (error) {
      log("error", "release_failed", { deliveryCount: message.deliveryCount, error: error.message });
      if (message.deliveryCount >= config.maxDeliveryCount) await bus.receiver.deadLetterMessage(message, { deadLetterReason: "ReleaseFailed", deadLetterErrorDescription: error.message.slice(0, 4096) });
      else await bus.receiver.abandonMessage(message);
    }
  },
  processError: async ({ error, errorSource }) => log("error", "release_bus_error", { source: errorSource, error: error.message }),
}, { autoCompleteMessages: false, maxConcurrentCalls: 1, maxAutoLockRenewalDurationInMs: (config.timeoutMs * 2) + 300_000 });

async function shutdown() {
  await subscription.close();
  await bus.receiver.close();
  await bus.sender.close();
  await bus.client.close();
}
process.once("SIGTERM", () => shutdown().catch((error) => log("error", "release_shutdown_failed", { error: error.message })));
process.once("SIGINT", () => shutdown().catch((error) => log("error", "release_shutdown_failed", { error: error.message })));
log("info", "release_started", { queue: config.releaseQueue });
