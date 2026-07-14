import { constants } from "node:fs";
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const generatedContextPath = /^(?:AGENTS\.md|\.agent-factory\/(?:architecture|commands|decisions|handoff|project|risks)\.md)$/;

async function copyMissing(source, destination) {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); return true; }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const metadata = await lstat(destination);
    if (metadata.isSymbolicLink()) throw new Error(`Refusing to initialize through symbolic link: ${destination}`);
    return false;
  }
}

export async function initializeProject(target, templateRoot) {
  const root = await realpath(target);
  const context = path.join(root, ".agent-factory");
  try { if ((await lstat(context)).isSymbolicLink()) throw new Error(".agent-factory cannot be a symbolic link"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(context, { recursive: true, mode: 0o750 });
  if (await realpath(context) !== context) throw new Error("Project context resolves outside repository");
  const agents = path.join(root, "AGENTS.md");
  const created = [];
  if (await copyMissing(path.join(templateRoot, "AGENTS.md"), agents)) created.push("AGENTS.md");
  for (const name of await readdir(path.join(templateRoot, "project"))) {
    const destination = path.join(context, name);
    if (await copyMissing(path.join(templateRoot, "project", name), destination)) created.push(`.agent-factory/${name}`);
  }
  if (created.length > 0) {
    const marker = path.join(context, ".local-files.json");
    let previous = [];
    try {
      const markerMetadata = await lstat(marker);
      if (!markerMetadata.isFile() || markerMetadata.isSymbolicLink()) throw new Error("Factory local-context marker must be a regular file");
      previous = JSON.parse(await readFile(marker, "utf8"));
      if (!Array.isArray(previous) || previous.some((name) => typeof name !== "string" || !generatedContextPath.test(name))) throw new Error("Factory local-context marker is invalid");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const temporary = `${marker}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify([...new Set([...previous, ...created])].sort())}\n`, { mode: 0o600 });
    await rename(temporary, marker);
  }
  return context;
}

export async function excludeLocalProjectContext(target) {
  const root = await realpath(target);
  const dotGit = path.join(root, ".git");
  const metadata = await lstat(dotGit);
  let git = dotGit;
  if (metadata.isFile()) {
    return null;
  } else if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(git) !== git) {
    throw new Error("Repository Git metadata is invalid");
  }
  const info = path.join(git, "info");
  await mkdir(info, { recursive: true, mode: 0o700 });
  if (await realpath(info) !== info) throw new Error("Repository Git info resolves outside the workspace");
  const file = path.join(info, "exclude");
  let existing = "";
  try { existing = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let generated = [];
  try { generated = JSON.parse(await readFile(path.join(root, ".agent-factory", ".local-files.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!Array.isArray(generated) || generated.length === 0) return file;
  if (generated.some((name) => typeof name !== "string" || !generatedContextPath.test(name))) throw new Error("Factory local-context marker contains an invalid path");
  const patterns = [...generated.map((name) => `/${name}`), "/.agent-factory/.local-files.json"];
  const missing = patterns.filter((pattern) => !existing.split("\n").includes(pattern));
  if (missing.length > 0) await appendFile(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}# Factory AI local context\n${missing.join("\n")}\n`, { mode: 0o600 });
  return file;
}

export async function supportsLocalProjectContext(target) {
  const root = await realpath(target);
  try { return (await lstat(path.join(root, ".git"))).isDirectory(); } catch { return false; }
}
