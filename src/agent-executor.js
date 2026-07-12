import { parseTaskResult } from "./validation.js";

export class AgentExecutor {
  constructor({ workspaces, agentRunner, sendControl }) {
    this.workspaces = workspaces;
    this.agentRunner = agentRunner;
    this.sendControl = sendControl;
  }

  async process(message) {
    if (message?.type === "planning_task") return this.processPlanning(message);
    if (message?.type === "agent_task") return this.processTask(message);
    throw new Error(`Unsupported agent message type: ${message?.type}`);
  }

  async processPlanning(message) {
    const directory = await this.workspaces.ensureObjective(message.objective);
    const delivery = await this.agentRunner.plan(message.objective, directory);
    await this.sendControl({ type: "planning_result", objectiveId: message.objectiveId, delivery });
  }

  async processTask(message) {
    const directory = await this.workspaces.prepareTask(
      message.objective,
      message.task,
      message.dependencyCommits ?? [],
    );
    const result = parseTaskResult(await this.agentRunner.invoke({
      objective: message.objective,
      task: message.task,
      directory,
      prompt: "Execute only this assigned task, verify it, and report factual outcomes.",
    }));
    const checkpoint = await this.workspaces.checkpoint(directory, message.objective, message.task);
    await this.sendControl({
      type: "result",
      objectiveId: message.objectiveId,
      taskId: message.task.id,
      status: "succeeded",
      ...result,
      ...checkpoint,
    });
  }
}
