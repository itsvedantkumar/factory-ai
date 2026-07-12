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
      await run("git", ["-C", control, "config", "user.name", "Agent Factory"]);
      await run("git", ["-C", control, "config", "user.email", "agent-factory@localhost"]);
    }
    return control;
  }

  async prepareTask(objective, task, dependencyCommits = []) {
    const control = await this.ensureObjective(objective);
    const directory = this.taskDirectory(objective.id, task.id);
    if (await exists(directory)) return directory;
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o750 });
    await run("git", ["-C", control, "fetch", "--prune", "origin", objective.baseBranch], { timeoutMs: this.timeoutMs });
    const base = dependencyCommits[0] ?? `origin/${objective.baseBranch}`;
    const branch = `agent-factory/${objective.id}/${task.id}`;
    await run("git", ["-C", control, "worktree", "add", "-b", branch, directory, base], { timeoutMs: this.timeoutMs });
    for (const commit of dependencyCommits.slice(1)) {
      await run("git", ["-C", directory, "merge", "--no-edit", commit], { timeoutMs: this.timeoutMs });
    }
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", branch], { timeoutMs: this.timeoutMs });
    return directory;
  }

  async checkpoint(directory, objective, task) {
    await run("git", ["-C", directory, "add", "-A"]);
    const diff = await run("git", ["-C", directory, "diff", "--cached", "--quiet"], { allowExitCodes: [0, 1] });
    if (diff.code === 1) {
      await run("git", ["-C", directory, "commit", "-m", `agent-factory(${task.role}): ${task.title}`], {
        timeoutMs: this.timeoutMs,
      });
    }
    const { stdout } = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
    const commit = stdout.trim();
    const branch = `agent-factory/${objective.id}/${task.id}`;
    await run("git", ["-C", directory, "push", "--set-upstream", "origin", branch], { timeoutMs: this.timeoutMs });
    return { commit, branch };
  }

}
