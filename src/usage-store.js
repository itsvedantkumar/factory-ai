import { lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createUsageRecordFromEvent, createUsageRecords, parseUsageRecord } from "./usage-record.js";

export async function syncUsageStore(stateRoot, factoryId, states, { now = new Date(), retentionDays = 90, maxBytes = 100_000_000 } = {}) {
  const directory = path.join(stateRoot, "usage", "v1");
  const file = path.join(directory, "usage.jsonl");
  await mkdir(directory, { recursive: true, mode: 0o750 });
  try { if ((await lstat(file)).isSymbolicLink()) throw new Error("Usage ledger cannot be a symbolic link"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const records = new Map();
  try {
    for (const line of (await readFile(file, "utf8")).split("\n").filter(Boolean)) {
      const record = parseUsageRecord(JSON.parse(line));
      if (record.granularity !== "reconciliation") records.set(record.recordId, record);
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const record of createUsageRecords(states, { now, retentionDays, factoryId })) records.set(record.recordId, record);
  const activityRoot = path.join(stateRoot, "activity");
  let objectiveDirectories = [];
  try { objectiveDirectories = await readdir(activityRoot, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  for (const objective of objectiveDirectories.filter((entry) => entry.isDirectory())) {
    for (const taskFile of (await readdir(path.join(activityRoot, objective.name))).filter((name) => name.endsWith(".jsonl"))) {
      const taskId = taskFile.slice(0, -6);
      for (const line of (await readFile(path.join(activityRoot, objective.name, taskFile), "utf8")).split("\n").filter(Boolean)) {
        try {
          const record = createUsageRecordFromEvent({ factoryId, objectiveId: objective.name, taskId, event: JSON.parse(line) });
          if (record) records.set(record.recordId, record);
        } catch {}
      }
    }
  }
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const requestTotals = new Map();
  for (const record of records.values()) {
    if (record.granularity !== "request") continue;
    const key = `${record.factoryId}\0${record.sessionId}\0${record.taskId}`;
    const total = requestTotals.get(key) ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
    for (const name of Object.keys(total)) total[name] += record.usage[name] ?? 0;
    requestTotals.set(key, total);
  }
  const reconciled = [];
  for (const record of records.values()) {
    if (record.granularity !== "task") { reconciled.push(record); continue; }
    const key = `${record.factoryId}\0${record.sessionId}\0${record.taskId}`;
    const total = requestTotals.get(key) ?? {};
    const usage = { inputTokens: Math.max(0, record.usage.inputTokens - (total.inputTokens ?? 0)), outputTokens: Math.max(0, record.usage.outputTokens - (total.outputTokens ?? 0)) };
    const cacheRead = Math.max(0, (record.usage.cacheReadInputTokens ?? 0) - (total.cacheReadInputTokens ?? 0));
    if (cacheRead) usage.cacheReadInputTokens = cacheRead;
    if (usage.inputTokens || usage.outputTokens || cacheRead) reconciled.push({ ...record, granularity: "reconciliation", recordId: createHash("sha256").update(`${record.recordId}\0reconciliation\0${JSON.stringify(usage)}`).digest("hex"), usage });
  }
  const sorted = reconciled.filter((record) => Date.parse(record.recordedAt) >= cutoff).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId));
  if (Buffer.byteLength(sorted.map((record) => JSON.stringify(record)).join("\n")) > maxBytes) throw new Error("Usage ledger exceeds 100 MB within the retention window");
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, sorted.map((record) => JSON.stringify(record)).join("\n") + (sorted.length ? "\n" : ""), { mode: 0o640 });
  await rename(temporary, file);
  return sorted;
}
