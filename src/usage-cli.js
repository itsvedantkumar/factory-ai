#!/usr/bin/env node
import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseUsageRecord } from "./usage-record.js";

export function usageRoot() { return path.resolve(process.env.FACTORY_AI_USAGE_DIR ?? path.join(os.homedir(), ".local", "share", "factory-ai", "usage")); }

export async function writeLocalUsage(root, records, { now = new Date(), retentionDays = 90, maxBytes = 100_000_000, authoritativeFactoryIds = new Set() } = {}) {
  const unique = new Map();
  const existing = await readLocalUsage(root);
  for (const value of [...existing.filter((record) => !authoritativeFactoryIds.has(record.factoryId)), ...records]) {
    const record = parseUsageRecord(value);
    const previous = unique.get(record.recordId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error(`Usage record conflict: ${record.recordId}`);
    unique.set(record.recordId, record);
  }
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const sorted = [...unique.values()].filter((record) => Date.parse(record.recordedAt) >= cutoff).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const groups = Map.groupBy(sorted, (record) => record.factoryId);
  for (const [factoryId, values] of groups) {
    const file = path.join(root, `${factoryId}.jsonl`);
    try { if (!(await lstat(file)).isFile()) throw new Error("Factory usage ledger must be a regular file"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const serialized = values.map((record) => JSON.stringify(record)).join("\n") + (values.length ? "\n" : "");
    if (Buffer.byteLength(serialized) > maxBytes) throw new Error(`Local usage ledger for ${factoryId} exceeds 100 MB`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, serialized, { mode: 0o600 });
    await rename(temporary, file);
  }
  for (const factoryId of authoritativeFactoryIds) if (!groups.has(factoryId)) await rm(path.join(root, `${factoryId}.jsonl`), { force: true });
  await rm(path.join(root, "usage.jsonl"), { force: true });
  return sorted;
}

export async function readLocalUsage(root = usageRoot(), { now = new Date(), retentionDays = 90 } = {}) {
  let text;
  let files;
  try { files = (await readdir(root)).filter((name) => name.endsWith(".jsonl")); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = new Map();
  for (const name of files) {
    const file = path.join(root, name);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 100_000_000) throw new Error("Factory usage ledger is unsafe or too large");
    text = await readFile(file, "utf8");
    for (const line of text.split("\n").filter(Boolean)) {
      const record = parseUsageRecord(JSON.parse(line));
      const previous = records.get(record.recordId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) throw new Error(`Usage record conflict: ${record.recordId}`);
      records.set(record.recordId, record);
    }
  }
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  return [...records.values()].filter((record) => Date.parse(record.recordedAt) >= cutoff).sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId));
}

export function usageReport(records) {
  const groups = new Map();
  for (const record of records) {
    const key = `${record.provider}/${record.model}`;
    const current = groups.get(key) ?? { model: key, requests: 0, inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 };
    current.requests += 1;
    current.inputTokens += record.usage.inputTokens;
    current.cacheReadInputTokens += record.usage.cacheReadInputTokens ?? 0;
    current.outputTokens += record.usage.outputTokens;
    groups.set(key, current);
  }
  return [...groups.values()].sort((left, right) => right.inputTokens - left.inputTokens || left.model.localeCompare(right.model));
}

export async function syncUsage({ account = process.env.FACTORY_STORAGE_ACCOUNT, root = usageRoot(), credential = new DefaultAzureCredential(), createClient = (url, auth) => new BlobServiceClient(url, auth) } = {}) {
  if (!/^[a-z0-9]{3,24}$/.test(account ?? "")) throw new Error("FACTORY_STORAGE_ACCOUNT is required");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const response = await createClient(`https://${account}.blob.core.windows.net`, credential).getContainerClient("operator").getBlobClient("usage/v1/usage.jsonl").download();
  if ((response.contentLength ?? 0) > 100_000_000) throw new Error("Factory usage ledger exceeds 100 MB");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.readableStreamBody) {
    bytes += chunk.length;
    if (bytes > 100_000_000) throw new Error("Factory usage ledger exceeds 100 MB");
    chunks.push(chunk);
  }
  const records = Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => parseUsageRecord(JSON.parse(line)));
  const factoryId = `factory-${createHash("sha256").update(account).digest("hex").slice(0, 16)}`;
  if (records.some((record) => record.factoryId !== factoryId)) throw new Error("Remote usage ledger factory identity mismatch");
  return writeLocalUsage(root, records, { authoritativeFactoryIds: new Set([factoryId]) });
}

async function main() {
  const [action = "report", ...args] = process.argv.slice(2);
  const offline = args.includes("--offline");
  if (!offline) await syncUsage();
  const records = await readLocalUsage();
  if (action === "sync") process.stdout.write(`${JSON.stringify({ source: "factory-ai", records: records.length, directory: usageRoot() })}\n`);
  else if (action === "export") process.stdout.write(records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""));
  else if (action === "report") {
    const report = usageReport(records);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ source: "factory-ai", displayName: "Factory AI", records: records.length, models: report }, null, 2)}\n`);
    else {
      process.stdout.write("Factory AI Token Usage\n\n");
      for (const item of report) process.stdout.write(`${item.model}\t${item.requests} requests\t${item.inputTokens} input\t${item.cacheReadInputTokens} cached\t${item.outputTokens} output\n`);
    }
  } else throw new Error("Usage: factory usage sync | report [--json] [--offline] | export [--offline]");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
