import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { run } from "./process.js";

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export class WorkspaceManager {
  constructor(root, timeoutMs) {
    this.root = root;
    this.timeoutMs = timeoutMs;
  }

  rootFor(objectiveId) {
    return path.join(this.root, objectiveId);
  }

  taskDirectory(objectiveId, taskId) {
    return path.join(this.rootFor(objectiveId), "tasks", taskId);
  }

  async ensureObjective(objective) {
    const root = this.rootFor(objective.id);
    const control = path.join(root, "control");
    if (!(await exists(path.join(control, ".git")))) {
      await mkdir(root, { recursive: true, mode: 0o750 });
      const temporary = `${control}.clone-${process.pid}`;
      await rm(temporary, { recursive: true, force: true });
      await run("git", ["clone", "--branch", objective.baseBranch, "--single-branch", objective.repository, temporary], {
        timeoutMs: this.timeoutMs,
      });
      await rename(temporary, control);
      await run("git", ["-C", control, "config", "user.name", "Factory AI"]);
      await run("git", ["-C", control, "config", "user.email", "factory-ai@localhost"]);
    }
    return control;
  }

  async prepareTask(objective, task, dependencyCommits = []) {
    const directory = this.taskDirectory(objective.id, task.id);
    const branch = `factory-ai/${objective.id}/${task.id}`;
    if (await exists(directory)) {
      const current = (await run("git", ["-C", directory, "branch", "--show-current"])).stdout.trim();
      if (current !== branch) throw new Error(`Existing task workspace is on unexpected branch: ${current}`);
      for (const commit of dependencyCommits) {
        const ancestor = await run("git", ["-C", directory, "merge-base", "--is-ancestor", commit, "HEAD"], { allowExitCodes: [0, 1] });
        if (ancestor.code !== 0) throw new Error(`Existing task workspace is missing dependency commit: ${commit}`);
      }
      return directory;
    }
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o750 });
    const base = dependencyCommits[0] ?? `origin/${objective.baseBranch}`;
    await run("git", ["clone", objective.repository, directory], { timeoutMs: this.timeoutMs });
    await run("git", ["-C", directory, "config", "user.name", "Factory AI"]);
    await run("git", ["-C", directory, "config", "user.email", "factory-ai@localhost"]);
    await run("git", ["-C", directory, "checkout", "-b", branch, base], { timeoutMs: this.timeoutMs });
    for (const commit of dependencyCommits.slice(1)) {
      await run("git", ["-C", directory, "merge", "--no-edit", commit], { timeoutMs: this.timeoutMs });
    }
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", branch], { timeoutMs: this.timeoutMs });
    return directory;
  }

  async recoveryContext(directory) {
    const status = (await run("git", ["-C", directory, "status", "--short"], { maxOutputBytes: 50_000 })).stdout.trim();
    if (!status) return "";
    const summary = (await run("git", ["-C", directory, "diff", "--stat"], { maxOutputBytes: 50_000 })).stdout.trim();
    return `RECOVERED DURABLE WORKTREE CHECKPOINT\nA previous attempt changed these files. Inspect and continue rather than repeating completed work.\n${status}${summary ? `\n\n${summary}` : ""}`;
  }

  async checkpoint(directory, objective, task) {
    await run("git", ["-C", directory, "add", "-A"]);
    const diff = await run("git", ["-C", directory, "diff", "--cached", "--quiet"], { allowExitCodes: [0, 1] });
    if (diff.code === 1) {
      await run("git", ["-C", directory, "commit", "-m", `factory-ai(${task.role}): ${task.title}`], {
        timeoutMs: this.timeoutMs,
      });
    }
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
    const commit = stdout.trim();
    const branch = `factory-ai/${objective.id}/${task.id}`;
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", branch], { timeoutMs: this.timeoutMs });
    return { commit, branch };
  }

  async reference(directory, objective, task) {
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
    return { commit: stdout.trim(), branch: `factory-ai/${objective.id}/${task.id}` };
  }

}
