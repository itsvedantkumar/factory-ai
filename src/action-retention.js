import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

export async function pruneActionStates(root, { maxEntries = 500, maxAgeMs = 30 * 86_400_000, now = new Date() } = {}) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  const states = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^action-[A-Za-z0-9_-]{1,57}$/.test(entry.name)) continue;
    try {
      const state = JSON.parse(await readFile(path.join(root, entry.name, "state.json"), "utf8"));
      if (["succeeded", "failed", "cancelled"].includes(state.status)) states.push({ name: entry.name, createdAt: Date.parse(state.createdAt ?? state.action?.createdAt ?? 0) });
    } catch {}
  }
  states.sort((left, right) => left.createdAt - right.createdAt);
  const remove = states.filter((item, index) => !Number.isFinite(item.createdAt) || now.getTime() - item.createdAt > maxAgeMs || index < states.length - maxEntries);
  for (const item of remove) await rm(path.join(root, item.name), { recursive: true, force: true });
}
