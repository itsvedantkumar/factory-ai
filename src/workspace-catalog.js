import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./process.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function repositoryFromRemote(remote) {
  const value = remote.trim().replace(/\.git$/, "");
  const match = value.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error("Workspace origin must be a github.com repository");
  return match[1];
}

async function exists(target) { try { await stat(target); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

export class WorkspaceCatalog {
  constructor({ file = process.env.FACTORY_WORKSPACES_FILE ?? path.join(os.homedir(), ".config", "factory-ai", "workspaces.json"), root = process.env.FACTORY_WORKSPACES_DIR ?? path.join(os.homedir(), "Factory Workspaces"), execute = run } = {}) {
    this.file = path.resolve(file);
    this.root = path.resolve(root);
    this.execute = execute;
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
    } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  }

  async save(workspaces) {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, workspaces }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
  }

  async withLock(operation) {
    const lock = `${this.file}.lock`;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const metadata = await stat(lock).catch(() => null);
        if (metadata && Date.now() - metadata.mtimeMs > 900_000) { await rm(lock, { recursive: true, force: true }); continue; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    throw new Error("Timed out acquiring workspace catalog lock");
  }

  async list() { return (await this.load()).sort((left, right) => left.name.localeCompare(right.name)); }

  async resolve(reference) {
    const workspaces = await this.load();
    const workspace = workspaces.find((item) => item.name === reference || item.repository === reference);
    if (workspace) return workspace;
    if (repositoryPattern.test(reference)) return { name: reference.split("/").at(-1), repository: reference, url: `https://github.com/${reference}.git`, baseBranch: "main" };
    throw new Error(`Unknown workspace: ${reference}. Run factory workspace list or import.`);
  }

  async import(source, options = {}) { return this.withLock(() => this.importUnlocked(source, options)); }

  async importUnlocked(source, { name } = {}) {
    let localPath;
    let repository;
    if (repositoryPattern.test(source)) {
      repository = source;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      localPath = path.join(this.root, source.replace("/", "--"));
      if (!(await exists(localPath))) await this.execute("gh", ["repo", "clone", source, localPath], { timeoutMs: 600_000 });
      const remote = await this.execute("git", ["-C", localPath, "remote", "get-url", "origin"]);
      if (repositoryFromRemote(remote.stdout) !== repository) throw new Error("Managed workspace origin does not match requested repository");
    } else {
      localPath = await realpath(path.resolve(source));
      const metadata = await stat(localPath);
      if (!metadata.isDirectory()) throw new Error("Workspace source must be a directory or owner/repo");
      const remote = await this.execute("git", ["-C", localPath, "remote", "get-url", "origin"]);
      repository = repositoryFromRemote(remote.stdout);
    }
    const defaultResult = await this.execute("git", ["-C", localPath, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowExitCodes: [0, 1] });
    const baseBranch = defaultResult.stdout.trim().replace(/^origin\//, "") || "main";
    const workspaceName = name ?? repository.split("/").at(-1);
    if (!namePattern.test(workspaceName)) throw new Error("Workspace name must use letters, numbers, dot, underscore, or dash");
    const workspaces = await this.load();
    const existing = workspaces.find((item) => item.name === workspaceName);
    if (existing && existing.repository !== repository) throw new Error(`Workspace name already exists: ${workspaceName}`);
    const workspace = { name: workspaceName, repository, url: `https://github.com/${repository}.git`, localPath, baseBranch, importedAt: new Date().toISOString() };
    await this.save([...workspaces.filter((item) => item.name !== workspaceName && item.repository !== repository), workspace]);
    return workspace;
  }

  async remove(name) { return this.withLock(() => this.removeUnlocked(name)); }

  async removeUnlocked(name) {
    const workspaces = await this.load();
    if (!workspaces.some((item) => item.name === name)) throw new Error(`Unknown workspace: ${name}`);
    await this.save(workspaces.filter((item) => item.name !== name));
    return { removed: name, filesPreserved: true };
  }
}

export const workspaceInternals = { repositoryFromRemote };
