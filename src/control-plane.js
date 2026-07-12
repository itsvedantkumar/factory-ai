import { parseObjective, parsePlan, parseResultMessage } from "./validation.js";
import { validateDeliveryGraph, readyTasks } from "./task-graph.js";
import { selectCapabilities } from "./capabilities.js";

export class ControlPlane {
  constructor({ store, registry, sendTask }) {
    this.store = store;
    this.registry = registry;
    this.sendTask = sendTask;
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
    await this.sendTask({
      type: "planning_task",
      objectiveId: objective.id,
      objective,
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
    if (latest.tasks.length > 0 && latest.tasks.every((task) => latest.results[task.id]?.status === "succeeded")) {
      await this.store.update(objectiveId, (current) => ({ ...current, status: "awaiting_release", completedAt: new Date().toISOString() }));
    }
  }
}
