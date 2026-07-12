import { readFile } from "node:fs/promises";
import { parseObjective, parsePlan, parseResultMessage, parseTaskResult, parseWorkMessage } from "./validation.js";
import { validateDeliveryGraph, readyTasks } from "./task-graph.js";
import { sendMessage } from "./bus.js";
import { log } from "./log.js";
import { selectCapabilities } from "./capabilities.js";
import { evaluateReleaseGate } from "./release.js";

export async function loadRegistry(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export class Orchestrator {
  constructor({ store, workspaces, agentRunner, release, sender }) {
    this.store = store;
    this.workspaces = workspaces;
    this.agentRunner = agentRunner;
    this.release = release;
    this.sender = sender;
  }

  async processObjective(body) {
    const objective = parseObjective(body);
    let state;
    try {
      state = await this.store.read(objective.id);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = await this.store.write(objective.id, {
        objective,
        status: "planning",
        tasks: [],
        results: {},
        createdAt: new Date().toISOString(),
      });
    }
    if (["complete", "failed", "blocked"].includes(state.status)) return;
    if (state.tasks.length === 0) {
      const control = await this.workspaces.ensureObjective(objective);
      const plan = parsePlan(await this.agentRunner.plan(objective, control));
      validateDeliveryGraph(plan.tasks);
      for (const task of plan.tasks) selectCapabilities(this.agentRunner.registry, task.role, task.capabilities);
      state = await this.store.update(objective.id, (current) => ({
        ...current,
        status: "running",
        executiveIntent: plan.executiveIntent,
        tasks: plan.tasks,
      }));
      log("info", "objective_planned", { objectiveId: objective.id, taskCount: plan.tasks.length });
    }
    await this.dispatchOrFinalize(objective.id);
  }

  async processTask(body) {
    const message = parseWorkMessage(body);
    const state = await this.store.read(message.objectiveId);
    const task = state.tasks.find((candidate) => candidate.id === message.task.id);
    if (!task || JSON.stringify(task) !== JSON.stringify(message.task)) throw new Error("Task does not match persisted plan");
    if (state.results[task.id]?.status === "succeeded") return;
    if (state.results[task.id]?.status === "emitted") {
      const result = parseResultMessage(state.results[task.id].message);
      await sendMessage(this.sender, result, `${message.objectiveId}:${task.id}:result:${result.commit}`, message.objectiveId);
      return;
    }
    if (!task.dependsOn.every((id) => state.results[id]?.status === "succeeded")) throw new Error("Task dependencies are incomplete");
    await this.store.update(message.objectiveId, (current) => ({
      ...current,
      results: {
        ...current.results,
        [task.id]: { status: "running", startedAt: new Date().toISOString() },
      },
    }));
    const dependencyCommits = task.dependsOn.map((id) => state.results[id]?.commit).filter(Boolean);
    const directory = await this.workspaces.prepareTask(state.objective, task, dependencyCommits);
    const response = parseTaskResult(await this.agentRunner.invoke({
      objective: state.objective,
      task,
      directory,
      prompt: "Execute the assigned work, run relevant checks, and report actual outcomes.",
    }));
    const checkpoint = await this.workspaces.checkpoint(directory, state.objective, task);
    const result = {
      type: "result",
      objectiveId: message.objectiveId,
      taskId: task.id,
      status: "succeeded",
      ...response,
      ...checkpoint,
    };
    parseResultMessage(result);
    await this.store.update(message.objectiveId, (current) => ({
      ...current,
      results: {
        ...current.results,
        [task.id]: { status: "emitted", message: result, emittedAt: new Date().toISOString() },
      },
    }));
    await sendMessage(this.sender, result, `${message.objectiveId}:${task.id}:result:${checkpoint.commit}`, message.objectiveId);
    log("info", "task_result_emitted", { objectiveId: message.objectiveId, taskId: task.id, role: task.role, commit: checkpoint.commit });
  }

  async processResult(body) {
    const message = parseResultMessage(body);
    const state = await this.store.read(message.objectiveId);
    const task = state.tasks.find((candidate) => candidate.id === message.taskId);
    if (!task) throw new Error("Result task does not match persisted plan");
    if (state.results[task.id]?.status === "succeeded") {
      await this.dispatchOrFinalize(message.objectiveId);
      return;
    }
    let release;
    if (task.role === "release") {
      const gate = evaluateReleaseGate(state.tasks, state.results);
      if (!gate.approved) throw new Error(`Release approvals missing: ${gate.blockers.join(", ")}`);
      release = await this.release.publish({
        directory: this.workspaces.taskDirectory(message.objectiveId, task.id),
        objective: state.objective,
        task,
        branch: message.branch,
        results: { ...state.results, [task.id]: message },
      });
    }
    await this.store.update(message.objectiveId, (current) => ({
      ...current,
      results: {
        ...current.results,
        [task.id]: {
          status: message.status,
          summary: message.summary,
          checks: message.checks,
          risks: message.risks,
          approval: message.approval,
          commit: message.commit,
          branch: message.branch,
          release,
          completedAt: new Date().toISOString(),
        },
      },
    }));
    if (["tester", "reviewer", "security"].includes(task.role) && message.approval !== "approved") {
      await this.store.update(message.objectiveId, (current) => ({
        ...current,
        status: "blocked",
        failure: `${task.role} ${task.id} requested changes: ${message.summary}`,
        completedAt: new Date().toISOString(),
      }));
    }
    log("info", "task_succeeded", { objectiveId: message.objectiveId, taskId: task.id, role: task.role });
    await this.dispatchOrFinalize(message.objectiveId);
  }

  async recordPermanentFailure(body, error) {
    const objectiveId = body.type === "objective" ? body.id : body.objectiveId;
    if (!objectiveId) return;
    try {
      await this.store.update(objectiveId, (state) => ({
        ...state,
        status: "failed",
        failure: String(error.message ?? error).slice(0, 4000),
        completedAt: new Date().toISOString(),
      }));
      await this.finalize(objectiveId);
    } catch (stateError) {
      log("error", "failure_state_write_failed", { objectiveId, error: stateError.message });
    }
  }

  async dispatchOrFinalize(objectiveId) {
    const state = await this.store.read(objectiveId);
    if (["complete", "failed", "blocked"].includes(state.status)) {
      await this.finalize(objectiveId);
      return;
    }
    const ready = readyTasks(state.tasks, state.results);
    for (const taskId of ready) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      if (task.role === "release") {
        const gate = evaluateReleaseGate(state.tasks, state.results);
        if (!gate.approved) continue;
      }
      await sendMessage(this.sender, { type: "task", objectiveId, task }, `${objectiveId}:${task.id}:v1`, objectiveId);
      await this.store.update(objectiveId, (current) => ({
        ...current,
        results: { ...current.results, [task.id]: { status: "queued", queuedAt: new Date().toISOString() } },
      }));
      log("info", "task_dispatched", { objectiveId, taskId: task.id, role: task.role });
    }
    const latest = await this.store.read(objectiveId);
    if (latest.tasks.length > 0 && latest.tasks.every((task) => latest.results[task.id]?.status === "succeeded")) {
      await this.store.update(objectiveId, (current) => ({
        ...current,
        status: "complete",
        completedAt: new Date().toISOString(),
      }));
      await this.finalize(objectiveId);
    }
  }

  async finalize(objectiveId) {
    const state = await this.store.read(objectiveId);
    const completed = Object.entries(state.results).filter(([, result]) => result.status === "succeeded");
    const release = completed.map(([, value]) => value.release).find(Boolean);
    const result = {
      objectiveId,
      status: state.status,
      executiveSummary: state.status === "complete"
        ? completed.map(([id, value]) => `${id}: ${value.summary}`).join("\n")
        : `Objective failed: ${state.failure ?? "unknown error"}`,
      commits: Object.fromEntries(completed.filter(([, value]) => value.commit).map(([id, value]) => [id, value.commit])),
      pullRequest: release?.url,
      checks: release?.checks ?? completed.flatMap(([id, value]) => value.checks.map((check) => `${id}: ${check}`)),
      blockers: [...(release?.blockers ?? []), ...(state.failure ? [state.failure] : [])],
      autoMergeEnabled: release?.autoMergeEnabled ?? false,
      completedAt: state.completedAt,
    };
    await this.store.writeResult(objectiveId, result);
    log("info", "objective_finalized", { objectiveId, status: state.status, pullRequest: result.pullRequest });
  }
}
