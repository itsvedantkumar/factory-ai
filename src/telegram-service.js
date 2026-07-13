#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { loadConfig } from "./config.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { sendMessage } from "./bus.js";
import { loadLocalState, loadQueueMetrics } from "./dashboard.js";
import { formatObjectiveProgress, isAllowedChat, objectiveFromTelegram, parseTelegramCommand } from "./telegram.js";
import { log } from "./log.js";
import { ActivityStore } from "./activity.js";

process.title = "factory-ai-telegram";
const config = loadConfig();
Object.assign(process.env, await loadRuntimeSecrets(config, undefined, ["TELEGRAM_BOT_TOKEN", "TELEGRAM_ALLOWED_CHAT_IDS"]));
const token = process.env.TELEGRAM_BOT_TOKEN;
const allowed = new Set((process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map((value) => value.trim()).filter(Boolean));
if (!token || allowed.size === 0) {
  log("info", "telegram_disabled", { reason: "missing token or chat allowlist" });
  process.exit(0);
}

const directory = path.join(config.stateDir, "telegram");
const offsetFile = path.join(directory, "offset");
const preferencesFile = path.join(directory, "preferences.json");
const subscriptionsFile = path.join(directory, "subscriptions.json");
await mkdir(directory, { recursive: true, mode: 0o750 });
let offset = 0;
try { offset = Number(await readFile(offsetFile, "utf8")) || 0; } catch (error) { if (error.code !== "ENOENT") throw error; }
async function loadJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
const preferences = await loadJson(preferencesFile);
const subscriptions = await loadJson(subscriptionsFile);

const client = new ServiceBusClient(config.serviceBusFqdn, new DefaultAzureCredential());
const sender = client.createSender(config.controlQueue);
const abort = new AbortController();
const activityStore = new ActivityStore(config.stateDir);

async function telegram(method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: abort.signal,
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method} failed: ${result.error_code ?? response.status}`);
  return result.result;
}

async function reply(chatId, text) {
  await telegram("sendMessage", { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
}

async function saveOffset(value) {
  const temporary = `${offsetFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${value}\n`, { mode: 0o640 });
  await rename(temporary, offsetFile);
}

async function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o640 });
  await rename(temporary, file);
}

async function statusText() {
  const [{ states }, queue] = await Promise.all([loadLocalState(config.stateDir), loadQueueMetrics(config)]);
  const counts = {};
  for (const state of states) counts[state.status ?? "unknown"] = (counts[state.status ?? "unknown"] ?? 0) + 1;
  return [config.factoryName, `Queue: ${queue.active} active, ${queue.deadLetter} dead-letter`, `Objectives: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`].join("\n");
}

async function processUpdate(update) {
  const message = update.message;
  if (!message?.text || !isAllowedChat(message.chat?.id, allowed)) return;
  try {
    const chatId = String(message.chat.id);
    const command = parseTelegramCommand(message.text, preferences[chatId]?.repository);
    if (command.type === "help") return reply(message.chat.id, "/repo OWNER/REPO\nPlain text objective\n/submit OWNER/REPO objective\n/goal [OWNER/REPO] objective\n/loop [OWNER/REPO] objective\n/status\n/recent\n/objective ID\n/help");
    if (command.type === "status") return reply(message.chat.id, await statusText());
    if (command.type === "set_repository") {
      preferences[chatId] = { repository: command.repository, updatedAt: new Date().toISOString() };
      await saveJson(preferencesFile, preferences);
      return reply(message.chat.id, `Default repository set to ${command.repository}. You can now send plain-text objectives.`);
    }
    if (command.type === "recent") {
      const { states } = await loadLocalState(config.stateDir);
      const text = states.slice(-10).reverse().map((state) => `${state.status ?? "unknown"} — ${state.objective?.id}\n${String(state.objective?.objective ?? "").slice(0, 150)}`).join("\n\n") || "No objectives.";
      return reply(message.chat.id, text);
    }
    if (command.type === "objective") {
      const state = JSON.parse(await readFile(path.join(config.stateDir, command.objectiveId, "state.json"), "utf8"));
      state.activity = await activityStore.latestObjective(command.objectiveId);
      return reply(message.chat.id, formatObjectiveProgress(state, config.factoryName));
    }
    const objective = objectiveFromTelegram(update.update_id, command);
    await sendMessage(sender, objective, objective.id);
    subscriptions[objective.id] = { chatId, lastDigest: "", createdAt: new Date().toISOString() };
    await saveJson(subscriptionsFile, subscriptions);
    await reply(message.chat.id, `Queued ${objective.id}\n${command.repository}\n${command.objective}`);
  } catch (error) {
    await reply(message.chat.id, `Rejected: ${String(error.message ?? error).slice(0, 500)}`);
  }
}

async function notifyProgress() {
  let changed = false;
  const terminal = new Set(["complete", "failed", "blocked", "denied", "expired", "cancelled"]);
  for (const [objectiveId, subscription] of Object.entries(subscriptions)) {
    let state;
    try { state = JSON.parse(await readFile(path.join(config.stateDir, objectiveId, "state.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    state.activity = await activityStore.latestObjective(objectiveId);
    const text = formatObjectiveProgress(state, config.factoryName);
    const digest = createHash("sha256").update(text).digest("hex");
    if (digest !== subscription.lastDigest) await reply(subscription.chatId, text);
    if (terminal.has(state.status)) { delete subscriptions[objectiveId]; changed = true; continue; }
    if (digest === subscription.lastDigest) continue;
    subscription.lastDigest = digest;
    subscription.lastStatus = state.status;
    subscription.notifiedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await saveJson(subscriptionsFile, subscriptions);
}

async function shutdown(signal) {
  log("info", "telegram_shutdown", { signal });
  abort.abort();
  await sender.close();
  await client.close();
}
process.once("SIGTERM", () => shutdown("SIGTERM").catch(() => {}));
process.once("SIGINT", () => shutdown("SIGINT").catch(() => {}));

log("info", "telegram_started", { allowedChatCount: allowed.size });
while (!abort.signal.aborted) {
  try {
    const updates = await telegram("getUpdates", { offset, timeout: 25, allowed_updates: ["message"] });
    for (const update of updates) {
      await processUpdate(update);
      offset = update.update_id + 1;
      await saveOffset(offset);
    }
    await notifyProgress();
  } catch (error) {
    if (abort.signal.aborted) break;
    log("error", "telegram_poll_failed", { error: String(error.message ?? error).replaceAll(token, "[REDACTED]").slice(0, 1000) });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
