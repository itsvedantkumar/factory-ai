import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";

async function copyMissing(source, destination) {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink()) throw new Error(`Refusing to initialize through symbolic link: ${destination}`);
  }
}

export async function initializeProject(target, templateRoot) {
  const root = await realpath(target);
  const context = path.join(root, ".agent-factory");
  try { if ((await lstat(context)).isSymbolicLink()) throw new Error(".agent-factory cannot be a symbolic link"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(context, { recursive: true, mode: 0o750 });
  if (await realpath(context) !== context) throw new Error("Project context resolves outside repository");
  const agents = path.join(root, "AGENTS.md");
  await copyMissing(path.join(templateRoot, "AGENTS.md"), agents);
  for (const name of await readdir(path.join(templateRoot, "project"))) {
    const destination = path.join(context, name);
    await copyMissing(path.join(templateRoot, "project", name), destination);
  }
  return context;
}
