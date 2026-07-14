import { parseApprovalDecisionMessage, parseApprovalRequestMessage, parseObjective, parsePlan, parseResultMessage } from "./validation.js";
import { validateDeliveryGraph, readyTasks } from "./task-graph.js";
import { selectCapabilities } from "./capabilities.js";
import { evaluateReleaseGate } from "./release-gate.js";

const TERMINAL_OBJECTIVE_STATES = new Set(["complete", "failed", "blocked", "cancelled", "denied", "expired"]);

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
    let state;
    try {
      state = await this.store.read(objective.id);
      if (state.status !== "planning" || state.tasks?.length > 0) return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = {
        objective,
        status: "planning",
        tasks: [],
        results: {},
        createdAt: new Date().toISOString(),
      };
      await this.store.write(objective.id, state);
    }
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
    let accepted = false;
    await this.store.update(value.objectiveId, (state) => {
      if (TERMINAL_OBJECTIVE_STATES.has(state.status)) return state;
      accepted = true;
      return { ...state, status: "running", executiveIntent: delivery.executiveIntent, tasks: delivery.tasks };
    });
    if (!accepted) return;
    await this.dispatch(value.objectiveId);
  }

  async acceptTaskResult(value) {
    const result = parseResultMessage(value);
    await this.store.update(result.objectiveId, (state) => TERMINAL_OBJECTIVE_STATES.has(state.status) ? state : ({
      ...state,
      results: { ...state.results, [result.taskId]: { ...result, completedAt: new Date().toISOString() } },
    }));
    await this.dispatch(result.objectiveId);
  }

  async acceptApprovalRequest(value) {
    const request = parseApprovalRequestMessage(value);
    await this.store.update(request.objectiveId, (state) => {
      if (TERMINAL_OBJECTIVE_STATES.has(state.status) || state.approval?.approvalId === request.approvalId) return state;
      if (state.status === "approval_required") return state;
      return { ...state, status: "approval_required", approval: { ...request, status: "approval_required" } };
    });
  }

  async acceptApprovalDecision(value) {
    const decision = parseApprovalDecisionMessage(value);
    let accepted = false;
    let approved = false;
    let retryDispatch = false;
    await this.store.update(decision.objectiveId, (state) => {
      if (state.status === "approved" && state.approval?.status === "approved" && state.approval.approvalId === decision.approvalId && state.approval.messageId === decision.messageId && decision.decision === "approved") {
        retryDispatch = true;
        return state;
      }
      if (["denied", "expired"].includes(state.status) && state.approval?.approvalId === decision.approvalId && state.approval.messageId === decision.messageId) {
        accepted = true;
        return state;
      }
      if (state.status !== "approval_required" || state.approval?.approvalId !== decision.approvalId) return state;
      if (decision.decision === "expired" && Date.parse(decision.decidedAt) < Date.parse(state.approval.expiresAt)) return state;
      const status = Date.parse(decision.decidedAt) >= Date.parse(state.approval.expiresAt) ? "expired" : decision.decision;
      accepted = true;
      approved = status === "approved";
      const results = { ...state.results };
      if (approved && state.approval.checkpoint) delete results[state.approval.checkpoint];
      return {
        ...state,
        status,
        results,
        approval: { ...state.approval, status, actor: decision.actor, reason: decision.reason, decidedAt: decision.decidedAt, messageId: decision.messageId },
      };
    });
    if ((accepted && approved) || retryDispatch) await this.dispatch(decision.objectiveId);
    if (accepted && !approved) {
      const state = await this.store.read(decision.objectiveId);
      await this.store.writeResult(decision.objectiveId, {
        objectiveId: decision.objectiveId,
        status: state.status,
        executiveSummary: state.executiveIntent ?? state.objective.objective,
        checks: [], blockers: [`Approval ${state.status}: ${decision.reason}`], autoMergeEnabled: false, completedAt: decision.decidedAt,
      });
    }
  }

  async acceptReleaseResult(value) {
    if (value?.type !== "release_result" || typeof value.objectiveId !== "string" || !value.release?.url) throw new Error("Invalid release result");
    let accepted = false;
    const state = await this.store.update(value.objectiveId, (current) => {
      if (current.status === "complete" && current.release?.url === value.release.url) {
        accepted = true;
        return current;
      }
      if (TERMINAL_OBJECTIVE_STATES.has(current.status)) return current;
      accepted = true;
      return { ...current, status: "complete", release: value.release, completedAt: new Date().toISOString() };
    });
    if (!accepted) return;
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

  async acceptFailure(value) {
    if (value?.type !== "failure_result" || typeof value.objectiveId !== "string" || typeof value.error !== "string") throw new Error("Invalid failure result");
    const blocker = `${value.taskId ?? "unknown-task"}: ${value.error}`;
    let accepted = false;
    const state = await this.store.update(value.objectiveId, (current) => {
      if (current.status === "failed" && current.failure === blocker) {
        accepted = true;
        return current;
      }
      if (TERMINAL_OBJECTIVE_STATES.has(current.status)) return current;
      accepted = true;
      return {
        ...current,
        status: "failed",
        failure: blocker,
        completedAt: new Date().toISOString(),
        results: value.taskId ? { ...current.results, [value.taskId]: { status: "failed", error: value.error, completedAt: new Date().toISOString() } } : current.results,
      };
    });
    if (!accepted) return;
    await this.store.writeResult(value.objectiveId, {
      objectiveId: value.objectiveId,
      status: "failed",
      executiveSummary: state.executiveIntent ?? state.objective.objective,
      checks: [],
      blockers: [blocker],
      autoMergeEnabled: false,
      completedAt: state.completedAt,
    });
  }

  async dispatch(objectiveId) {
    const state = await this.store.read(objectiveId);
    if (state.status === "blocked" && state.failure) {
      await this.store.writeResult(objectiveId, { objectiveId, status: "blocked", executiveSummary: state.executiveIntent ?? state.objective.objective, checks: [], blockers: [state.failure], autoMergeEnabled: false, completedAt: state.completedAt });
      return;
    }
    if (TERMINAL_OBJECTIVE_STATES.has(state.status) || state.status === "approval_required") return;
    for (const taskId of readyTasks(state.tasks, state.results)) {
      const task = state.tasks.find((candidate) => candidate.id === taskId);
      const dependencyCommits = task.dependsOn.map((id) => state.results[id]?.commit).filter(Boolean);
      const approvalGranted = state.status === "approved" && state.approval?.status === "approved" && state.approval?.checkpoint === task.id;
      await this.sendTask({ type: "agent_task", objectiveId, objective: state.objective, task, dependencyCommits, ...(approvalGranted ? { approvalGranted: true } : {}) });
      await this.store.update(objectiveId, (current) => ({
        ...current,
        results: { ...current.results, [taskId]: { status: "queued", queuedAt: new Date().toISOString() } },
      }));
    }
    const latest = await this.store.read(objectiveId);
    if (latest.status !== "releasing" && latest.tasks.length > 0 && latest.tasks.every((task) => latest.results[task.id]?.status === "succeeded")) {
      const gate = evaluateReleaseGate(latest.tasks, latest.results);
      if (!gate.approved) {
        const blocked = await this.store.update(objectiveId, (current) => ({ ...current, status: "blocked", failure: gate.blockers.join(", "), completedAt: new Date().toISOString() }));
        await this.store.writeResult(objectiveId, { objectiveId, status: "blocked", executiveSummary: blocked.executiveIntent ?? blocked.objective.objective, checks: [], blockers: gate.blockers, autoMergeEnabled: false, completedAt: blocked.completedAt });
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
