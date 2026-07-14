import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./process.js";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const trustedGitPaths = new Set(["/usr/bin/git", "/opt/homebrew/bin/git", "/opt/local/bin/git", "/usr/local/bin/git"]);

function trustedGitPath() {
  if (process.env.FACTORY_GIT_PATH && trustedGitPaths.has(process.env.FACTORY_GIT_PATH)) return process.env.FACTORY_GIT_PATH;
  for (const candidate of trustedGitPaths) if (existsSync(candidate)) return realpathSync(candidate);
  throw new Error("Unable to locate a trusted absolute Git executable");
}

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
    this.git = trustedGitPath();
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
      if (!(await exists(localPath))) {
        const temporary = `${localPath}.clone-${process.pid}`;
        await rm(temporary, { recursive: true, force: true });
        try {
          await this.execute("gh", ["repo", "clone", source, temporary], { timeoutMs: 600_000 });
          if (!(await exists(path.join(temporary, ".git")))) throw new Error("GitHub clone did not create a Git repository");
          await rename(temporary, localPath);
        } catch (error) {
          await rm(temporary, { recursive: true, force: true });
          throw error;
        }
      } else if (!(await exists(path.join(localPath, ".git")))) {
        throw new Error(`Managed workspace path is not a valid clone; move or remove it before retrying: ${localPath}`);
      }
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
    let baseBranch = defaultResult.stdout.trim().replace(/^origin\//, "");
    if (!baseBranch) {
      const remoteDefault = await this.execute("gh", ["repo", "view", repository, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], { timeoutMs: 60_000 });
      baseBranch = remoteDefault.stdout.trim();
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(baseBranch)) throw new Error(`Unable to determine a safe default branch for ${repository}`);
    const workspaceName = name ?? repository.split("/").at(-1);
    if (!namePattern.test(workspaceName)) throw new Error("Workspace name must use letters, numbers, dot, underscore, or dash");
    const workspaces = await this.load();
    const existing = workspaces.find((item) => item.name === workspaceName);
    if (existing && existing.repository !== repository) throw new Error(`Workspace name already exists: ${workspaceName}`);
    const previous = workspaces.find((item) => item.name === workspaceName || item.repository === repository);
    const workspace = { name: workspaceName, repository, url: `https://github.com/${repository}.git`, localPath, baseBranch, importedAt: previous?.importedAt ?? new Date().toISOString(), ...(previous?.sync ? { sync: previous.sync } : {}) };
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

  async setSync(name, enabled) {
    return this.withLock(async () => {
      const workspaces = await this.load();
      const index = workspaces.findIndex((item) => item.name === name);
      if (index < 0) throw new Error(`Unknown workspace: ${name}`);
      workspaces[index] = {
        ...workspaces[index],
        sync: { ...workspaces[index].sync, enabled, lastStatus: enabled ? workspaces[index].sync?.lastStatus ?? "pending" : "disabled", lastError: undefined },
      };
      await this.save(workspaces);
      return workspaces[index];
    });
  }

  async syncEnabled() { return (await this.load()).filter((item) => item.sync?.enabled); }

  async sync(name) {
    return this.withLock(async () => {
      const workspaces = await this.load();
      const index = workspaces.findIndex((item) => item.name === name);
      if (index < 0) throw new Error(`Unknown workspace: ${name}`);
      const workspace = workspaces[index];
      try {
        const result = await this.syncUnlocked(workspace);
        workspaces[index] = { ...workspace, sync: { ...workspace.sync, lastStatus: result.status, lastSyncedAt: new Date().toISOString(), lastError: undefined } };
        await this.save(workspaces);
        return { name, ...result };
      } catch (error) {
        workspaces[index] = { ...workspace, sync: { ...workspace.sync, lastStatus: "blocked", lastAttemptedAt: new Date().toISOString(), lastError: error.message.slice(0, 500) } };
        await this.save(workspaces);
        throw error;
      }
    });
  }

  async syncUnlocked(workspace) {
    const localPath = await realpath(workspace.localPath);
    if (localPath !== workspace.localPath) throw new Error(`Workspace path changed since import: ${workspace.name}`);
    const metadata = await stat(localPath);
    const git = (...args) => this.execute(this.git, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", localPath, ...args], { timeoutMs: 300_000 });
    const executableConfig = await this.execute(this.git, ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-C", localPath, "config", "--local", "--name-only", "--get-regexp", "^(filter\\..*\\.(clean|smudge|process)|credential\\.|core\\.(hooksPath|fsmonitor|sshCommand)|remote\\..*\\.(uploadpack|receivepack)|url\\..*\\.insteadOf|protocol\\..*\\.allow|diff\\..*\\.command|merge\\..*\\.driver)$"], { timeoutMs: 60_000, allowExitCodes: [0, 1] });
    if (executableConfig.stdout.trim()) throw new Error(`Workspace has executable local Git configuration; remove it before sync: ${workspace.name}`);
    const remote = await git("remote", "get-url", "origin");
    const remoteURL = remote.stdout.trim();
    if (repositoryFromRemote(remoteURL) !== workspace.repository) throw new Error(`Workspace origin changed since import: ${workspace.name}`);
    const branchResult = await git("symbolic-ref", "--short", "HEAD");
    const branch = branchResult.stdout.trim();
    if (!branch) throw new Error(`Workspace is on a detached HEAD: ${workspace.name}`);
    if (branch !== workspace.baseBranch) throw new Error(`Workspace must be on ${workspace.baseBranch} to sync; current branch is ${branch}`);
    const status = await git("status", "--porcelain", "--untracked-files=normal");
    if (status.stdout.trim()) throw new Error(`Workspace has uncommitted changes; commit or stash them before sync: ${workspace.name}`);
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error(`Unable to resolve workspace commit: ${workspace.name}`);
    await git("fetch", remoteURL, `refs/heads/${workspace.baseBranch}:refs/remotes/origin/${workspace.baseBranch}`);
    const remoteCommit = (await git("rev-parse", `origin/${workspace.baseBranch}`)).stdout.trim();
    if (!/^[a-f0-9]{40,64}$/.test(remoteCommit)) throw new Error(`Unable to resolve GitHub commit: ${workspace.name}`);
    const counts = await git("rev-list", "--left-right", "--count", `${head}...${remoteCommit}`);
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    if (![ahead, behind].every(Number.isSafeInteger)) throw new Error(`Unable to compare workspace with GitHub: ${workspace.name}`);
    if (ahead > 0 && behind > 0) throw new Error(`Workspace and GitHub have diverged; reconcile them manually: ${workspace.name}`);
    if (behind > 0) {
      const changed = (await git("diff", "--name-only", "-z", `${head}..${remoteCommit}`)).stdout.split("\0").filter(Boolean);
      const ignored = (await git("status", "--ignored=matching", "--porcelain=v1", "-z", "--untracked-files=all")).stdout.split("\0").filter((entry) => entry.startsWith("!! ")).map((entry) => entry.slice(3).replace(/\/$/, ""));
      const collisions = changed.filter((file) => ignored.some((ignoredPath) => file === ignoredPath || file.startsWith(`${ignoredPath}/`) || ignoredPath.startsWith(`${file}/`)));
      if (collisions.length > 0) throw new Error(`GitHub changes would overwrite ignored local files: ${collisions.slice(0, 5).join(", ")}`);
    }
    const revalidate = async () => {
      const currentPath = await realpath(workspace.localPath);
      const currentMetadata = await stat(currentPath);
      if (currentPath !== localPath || currentMetadata.dev !== metadata.dev || currentMetadata.ino !== metadata.ino) throw new Error(`Workspace path changed during sync: ${workspace.name}`);
      const currentRemote = (await git("remote", "get-url", "origin")).stdout.trim();
      if (currentRemote !== remoteURL) throw new Error(`Workspace origin changed during sync: ${workspace.name}`);
      if ((await git("symbolic-ref", "--short", "HEAD")).stdout.trim() !== branch || (await git("rev-parse", "HEAD")).stdout.trim() !== head) throw new Error(`Workspace changed during sync; retry: ${workspace.name}`);
    };
    if (behind > 0) {
      await revalidate();
      await git("merge", "--ff-only", remoteCommit);
      return { status: "pulled", ahead: 0, behind };
    }
    if (ahead > 0) {
      await revalidate();
      await git("push", remoteURL, `${head}:refs/heads/${workspace.baseBranch}`);
      return { status: "pushed", ahead, behind: 0 };
    }
    return { status: "synced", ahead: 0, behind: 0 };
  }
}

export const workspaceInternals = { repositoryFromRemote };
