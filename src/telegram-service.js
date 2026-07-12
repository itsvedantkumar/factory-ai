#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { DefaultAzureCredential } from "@azure/identity";
import { ServiceBusClient } from "@azure/service-bus";
import { loadConfig } from "./config.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { sendMessage } from "./bus.js";
import { loadLocalState, loadQueueMetrics } from "./dashboard.js";
import { isAllowedChat, objectiveFromTelegram, parseTelegramCommand } from "./telegram.js";
import { log } from "./log.js";

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
await mkdir(directory, { recursive: true, mode: 0o750 });
let offset = 0;
try { offset = Number(await readFile(offsetFile, "utf8")) || 0; } catch (error) { if (error.code !== "ENOENT") throw error; }

const client = new ServiceBusClient(config.serviceBusFqdn, new DefaultAzureCredential());
const sender = client.createSender(config.controlQueue);
const abort = new AbortController();

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

async function statusText() {
  const [{ states }, queue] = await Promise.all([loadLocalState(config.stateDir), loadQueueMetrics(config)]);
  const counts = {};
  for (const state of states) counts[state.status ?? "unknown"] = (counts[state.status ?? "unknown"] ?? 0) + 1;
  return [`Factory AI`, `Queue: ${queue.active} active, ${queue.deadLetter} dead-letter`, `Objectives: ${Object.entries(counts).map(([name, count]) => `${name} ${count}`).join(", ") || "none"}`].join("\n");
}

async function processUpdate(update) {
  const message = update.message;
  if (!message?.text || !isAllowedChat(message.chat?.id, allowed)) return;
  try {
    const command = parseTelegramCommand(message.text);
    if (command.type === "help") return reply(message.chat.id, "/submit OWNER/REPO objective\n/goal OWNER/REPO objective\n/loop OWNER/REPO objective\n/status\n/help");
    if (command.type === "status") return reply(message.chat.id, await statusText());
    const objective = objectiveFromTelegram(update.update_id, command);
    await sendMessage(sender, objective, objective.id);
    await reply(message.chat.id, `Queued ${objective.id}\n${command.repository}\n${command.objective}`);
  } catch (error) {
    await reply(message.chat.id, `Rejected: ${String(error.message ?? error).slice(0, 500)}`);
  }
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
  } catch (error) {
    if (abort.signal.aborted) break;
    log("error", "telegram_poll_failed", { error: String(error.message ?? error).replaceAll(token, "[REDACTED]").slice(0, 1000) });
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
