#!/usr/bin/env node
import { WorkspaceCatalog } from "./workspace-catalog.js";
import { WorkspaceSyncScheduler } from "./workspace-sync-scheduler.js";
import { initializeProject } from "./project-init.js";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const usage = "Usage: factory workspace list | import SOURCE [--name NAME] | show NAME | remove NAME | sync enable|disable|now|status [NAME]";

async function syncAll(catalog) {
  const results = [];
  for (const workspace of await catalog.syncEnabled()) {
    try { results.push(await catalog.sync(workspace.name)); }
    catch (error) { results.push({ name: workspace.name, status: "blocked", error: error.message.slice(0, 500) }); }
  }
  return results;
}

export async function runWorkspaceCLI(args, {
  catalog = new WorkspaceCatalog(),
  scheduler = new WorkspaceSyncScheduler(),
  initialize = (localPath) => initializeProject(localPath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates")),
} = {}) {
  const [action = "list", source, ...rest] = args;
  if (action === "list") return catalog.list();
  if (action === "show") return catalog.resolve(source);
  if (action === "import") {
    const nameIndex = rest.indexOf("--name");
    const workspace = await catalog.import(source, { name: nameIndex >= 0 ? rest[nameIndex + 1] : undefined });
    await initialize(workspace.localPath);
    return workspace;
  }
  if (action === "remove") {
    const enabled = await catalog.syncEnabled();
    if (enabled.length === 1 && enabled[0].name === source) await scheduler.disable();
    return catalog.remove(source);
  }
  if (action !== "sync") throw new Error(usage);
  const [syncAction = "status", name] = [source, ...rest];
  if (syncAction === "enable") {
    if (!name) throw new Error(usage);
    try {
      await scheduler.enable();
      const result = await catalog.sync(name);
      await catalog.setSync(name, true);
      return result;
    } catch (error) {
      if ((await catalog.syncEnabled().catch(() => [])).length === 0) await scheduler.disable().catch(() => {});
      throw error;
    }
  }
  if (syncAction === "disable") {
    if (!name) throw new Error(usage);
    const enabled = await catalog.syncEnabled();
    if (enabled.length === 1 && enabled[0].name === name) await scheduler.disable();
    return catalog.setSync(name, false);
  }
  if (syncAction === "now") return name ? catalog.sync(name) : syncAll(catalog);
  if (syncAction === "run") return syncAll(catalog);
  if (syncAction === "status") return { scheduler: await scheduler.status(), workspaces: (await catalog.list()).map((workspace) => ({ name: workspace.name, repository: workspace.repository, sync: workspace.sync ?? { enabled: false, lastStatus: "disabled" } })) };
  throw new Error(usage);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const arguments_ = process.argv.slice(2);
  runWorkspaceCLI(arguments_).then((result) => {
    if (!(arguments_[0] === "sync" && arguments_[1] === "run")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
