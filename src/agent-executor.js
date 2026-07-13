import { parseTaskResult } from "./validation.js";

export class AgentExecutor {
  constructor({ workspaces, agentRunner, scannerSuite, retriever, sendControl }) {
    this.workspaces = workspaces;
    this.agentRunner = agentRunner;
    this.scannerSuite = scannerSuite;
    this.retriever = retriever;
    this.sendControl = sendControl;
  }

  async process(message) {
    if (message?.type === "planning_task") return this.processPlanning(message);
    if (message?.type === "agent_task") return this.processTask(message);
    throw new Error(`Unsupported agent message type: ${message?.type}`);
  }

  async processPlanning(message) {
    const directory = await this.workspaces.ensureObjective(message.objective);
    let semanticContext = "";
    try { semanticContext = this.retriever ? await this.retriever.context(directory, message.objective.repository, message.objective.objective) : ""; } catch {}
    const context = [...(message.context ?? []), ...(semanticContext ? [{ type: "local-semantic-retrieval", content: semanticContext }] : [])];
    const delivery = await this.agentRunner.plan(message.objective, directory, context);
    await this.sendControl({ type: "planning_result", objectiveId: message.objectiveId, delivery });
  }

  async processTask(message) {
    const directory = await this.workspaces.prepareTask(
      message.objective,
      message.task,
      message.dependencyCommits ?? [],
    );
    const scannerEvidence = message.task.role === "security" && this.scannerSuite
      ? await this.scannerSuite.scan(directory)
      : [];
    let semanticContext = "";
    if (message.task.role !== "release" && this.retriever) {
      const query = `${message.objective.objective}\n${message.task.title}\n${message.task.instructions}`;
      try { semanticContext = await this.retriever.context(directory, message.objective.repository, query); } catch {}
    }
    const prompt = [
      "Execute only this assigned task, verify it, and report factual outcomes.",
      ...(scannerEvidence.length ? [`TRUSTED SCANNER EVIDENCE (mechanical output; do not claim checks beyond this evidence):\n${JSON.stringify(scannerEvidence)}`] : []),
      ...(semanticContext ? [`LOCAL SEMANTIC CONTEXT (retrieved from this exact repository revision):\n${semanticContext}`] : []),
    ].join("\n\n");
    const result = parseTaskResult(await this.agentRunner.invoke({
      objective: message.objective,
      task: message.task,
      directory,
      prompt,
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
