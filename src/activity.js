import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const identifier = /^[A-Za-z0-9_-]{1,64}$/;
const terminal = new Set(["succeeded", "failed", "cancelled"]);

export function isStaleActivity(activity, taskStatus, now = new Date(), staleSeconds = 120) {
  if (!activity?.occurredAt || terminal.has(taskStatus)) return false;
  return now.getTime() - new Date(activity.occurredAt).getTime() > staleSeconds * 1000;
}

export class ActivityStore {
  constructor(stateRoot) {
    this.root = path.join(stateRoot, "activity");
    this.maxFileBytes = 5_000_000;
  }

  directory(objectiveId) {
    if (!identifier.test(objectiveId)) throw new Error("Invalid objective activity ID");
    return path.join(this.root, objectiveId);
  }

  async withTaskLock(objectiveId, taskId, operation) {
    if (!identifier.test(taskId)) throw new Error("Invalid task activity ID");
    const directory = this.directory(objectiveId);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    const lock = path.join(directory, `${taskId}.lock`);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(lock, { mode: 0o750 });
        try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const metadata = await stat(lock);
          if (Date.now() - metadata.mtimeMs > 30_000) { await rm(lock, { recursive: true, force: true }); continue; }
        } catch (statError) { if (statError.code !== "ENOENT") throw statError; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error(`Timed out acquiring activity lock for ${taskId}`);
  }

  async append(objectiveId, taskId, event) {
    return this.withTaskLock(objectiveId, taskId, async () => {
      const file = path.join(this.directory(objectiveId), `${taskId}.jsonl`);
      try {
        const metadata = await stat(file);
        if (metadata.size > this.maxFileBytes) {
          const content = await readFile(file, "utf8");
          const retained = content.slice(-Math.floor(this.maxFileBytes / 2));
          const boundary = retained.indexOf("\n");
          const temporary = `${file}.${process.pid}.tmp`;
          await writeFile(temporary, boundary >= 0 ? retained.slice(boundary + 1) : retained, { mode: 0o640 });
          await rename(temporary, file);
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const value = { ...event, occurredAt: event.occurredAt ?? new Date().toISOString() };
      await appendFile(file, `${JSON.stringify(value)}\n`, { mode: 0o640 });
      return value;
    });
  }

  async latestTask(objectiveId, taskId) {
    if (!identifier.test(taskId)) throw new Error("Invalid task activity ID");
    let lines;
    try { lines = (await readFile(path.join(this.directory(objectiveId), `${taskId}.jsonl`), "utf8")).split("\n").filter(Boolean); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { const event = JSON.parse(lines[index]); if (event.type !== "telemetry.recorded") return event; } catch {}
    }
    return undefined;
  }

  async latestObjective(objectiveId) {
    const directory = this.directory(objectiveId);
    let files;
    try { files = await readdir(directory); } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    const result = {};
    for (const file of files.filter((name) => name.endsWith(".jsonl"))) {
      const lines = (await readFile(path.join(directory, file), "utf8")).split("\n").filter(Boolean);
      let latest;
      let retryCount = 0;
      let lastError;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type !== "telemetry.recorded") latest = event;
          if (event.type === "model.retry") retryCount += 1;
          if (event.error || event.type?.endsWith(".failed")) lastError = event.error ?? event.status;
        } catch {}
      }
      if (latest) result[file.slice(0, -6)] = { ...latest, retryCount, lastError };
    }
    return result;
  }
}
