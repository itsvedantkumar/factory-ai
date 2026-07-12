import { parseObjective, parsePlan, parseResultMessage } from "./validation.js";
import { validateDeliveryGraph, readyTasks } from "./task-graph.js";
import { selectCapabilities } from "./capabilities.js";
import { evaluateReleaseGate } from "./release-gate.js";

export class ControlPlane {
  constructor({ store, memory, registry, sendTask, sendRelease = async () => { throw new Error("Release sender is unavailable"); } }) {
    this.store = store;
    this.memory = memory;
    this.registry = registry;
    this.sendTask = sendTask;
    this.sendRelease = sendRelease;
  }

  async acceptObjective(value) {
    const objective = parseObjective(value);
    try {
      await this.store.read(objective.id);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await this.store.write(objective.id, {
      objective,
      status: "planning",
      tasks: [],
      results: {},
      createdAt: new Date().toISOString(),
    });
    const context = this.memory ? await this.memory.context(objective.repository) : [];
    await this.sendTask({
      type: "planning_task",
      objectiveId: objective.id,
      objective,
      context,
      task: {
        id: "planner0",
        role: "planner",
        title: "Create delivery graph",
        instructions: "Create the smallest safe delivery graph.",
        dependsOn: [],
        capabilities: [],
      },
    });
  }

  async acceptPlanningResult(value) {
    if (value?.type !== "planning_result" || typeof value.objectiveId !== "string") throw new Error("Invalid planning result");
    const delivery = parsePlan(value.delivery);
    validateDeliveryGraph(delivery.tasks);
    for (const task of delivery.tasks) selectCapabilities(this.registry, task.role, task.capabilities);
    await this.store.update(value.objectiveId, (state) => ({
      ...state,
      status: "running",
      executiveIntent: delivery.executiveIntent,
      tasks: delivery.tasks,
    }));
    await this.dispatch(value.objectiveId);
  }

  async acceptTaskResult(value) {
    const result = parseResultMessage(value);
    await this.store.update(result.objectiveId, (state) => ({
      ...state,
      results: {
        ...state.results,
        [result.taskId]: { ...result, completedAt: new Date().toISOString() },
      },
    }));
    await this.dispatch(result.objectiveId);
  }

  async acceptReleaseResult(value) {
    if (value?.type !== "release_result" || typeof value.objectiveId !== "string" || !value.release?.url) throw new Error("Invalid release result");
    const state = await this.store.update(value.objectiveId, (current) => ({ ...current, status: "complete", release: value.release, completedAt: new Date().toISOString() }));
    await this.store.writeResult(value.objectiveId, {
      objectiveId: value.objectiveId,
      status: "complete",
      executiveSummary: state.executiveIntent ?? state.objective.objective,
      pullRequest: value.release.url,
      checks: value.release.checks ?? [],
      blockers: value.release.blockers ?? [],
      autoMergeEnabled: value.release.autoMergeEnabled ?? false,
      completedAt: state.completedAt,
    });
    if (this.memory) await this.memory.append({
      type: "objective-completed",
      objectiveId: value.objectiveId,
      repository: state.objective.repository,
      objective: state.objective.objective,
      executiveIntent: state.executiveIntent,
      pullRequest: value.release.url,
      checks: value.release.checks ?? [],
      blockers: value.release.blockers ?? [],
    });
  }

  async dispatch(objectiveId) {
    const state = await this.store.read(objectiveId);
    for (const taskId of readyTasks(state.tasks, state.results)) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      const dependencyCommits = task.dependsOn.map((id) => state.results[id]?.commit).filter(Boolean);
      await this.sendTask({ type: "agent_task", objectiveId, objective: state.objective, task, dependencyCommits });
      await this.store.update(objectiveId, (current) => ({
        ...current,
        results: { ...current.results, [taskId]: { status: "queued", queuedAt: new Date().toISOString() } },
      }));
    }
    const latest = await this.store.read(objectiveId);
    if (latest.status !== "releasing" && latest.tasks.length > 0 && latest.tasks.every((task) => latest.results[task.id]?.status === "succeeded")) {
      const gate = evaluateReleaseGate(latest.tasks, latest.results);
      if (!gate.approved) {
        await this.store.update(objectiveId, (current) => ({ ...current, status: "blocked", failure: gate.blockers.join(", ") }));
        return;
      }
      const releaseTask = latest.tasks.find((task) => task.role === "release");
      await this.sendRelease({
        type: "publish_request",
        objectiveId,
        objective: latest.objective,
        branch: latest.results[releaseTask.id].branch,
        results: latest.results,
      });
      await this.store.update(objectiveId, (current) => ({ ...current, status: "releasing" }));
    }
  }
}
