#!/usr/bin/env node
import { WorkspaceCatalog } from "./workspace-catalog.js";
import { initializeProject } from "./project-init.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const catalog = new WorkspaceCatalog();
const [action = "list", source, ...rest] = process.argv.slice(2);
if (action === "list") process.stdout.write(`${JSON.stringify(await catalog.list(), null, 2)}\n`);
else if (action === "show") process.stdout.write(`${JSON.stringify(await catalog.resolve(source), null, 2)}\n`);
else if (action === "import") {
  const nameIndex = rest.indexOf("--name");
  const workspace = await catalog.import(source, { name: nameIndex >= 0 ? rest[nameIndex + 1] : undefined });
  await initializeProject(workspace.localPath, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates"));
  process.stdout.write(`${JSON.stringify(workspace, null, 2)}\n`);
} else if (action === "remove") process.stdout.write(`${JSON.stringify(await catalog.remove(source), null, 2)}\n`);
else throw new Error("Usage: factory workspace list | import PATH|OWNER/REPO [--name NAME] | show NAME | remove NAME");
