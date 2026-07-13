import { parseTaskResult } from "./validation.js";
import { buildRepositoryMap } from "./repo-map.js";
import { runHooks } from "./hooks.js";

export class AgentExecutor {
  constructor({ workspaces, agentRunner, scannerSuite, retriever, sendControl, buildRepoMap = buildRepositoryMap, repoMapMaxCharacters = 8000, hooks = [], hookHandlers = {} }) {
    this.workspaces = workspaces;
    this.agentRunner = agentRunner;
    this.scannerSuite = scannerSuite;
    this.retriever = retriever;
    this.sendControl = sendControl;
    this.buildRepoMap = buildRepoMap;
    this.repoMapMaxCharacters = repoMapMaxCharacters;
    this.hooks = hooks;
    this.hookHandlers = hookHandlers;
  }

  async process(message) {
    if (message?.type === "planning_task") return this.processPlanning(message);
    if (message?.type === "agent_task") return this.processTask(message);
    throw new Error(`Unsupported agent message type: ${message?.type}`);
  }

  async processPlanning(message) {
    const directory = await this.workspaces.ensureObjective(message.objective);
    let repoMap = { text: "", entries: [] };
    try { repoMap = await this.buildRepoMap(directory, message.objective.objective, { maxCharacters: this.repoMapMaxCharacters }); } catch {}
    let semanticContext = "";
    try { semanticContext = this.retriever ? await this.retriever.context(directory, message.objective.repository, message.objective.objective, { repositoryEntries: repoMap.entries }) : ""; } catch {}
    const context = [
      ...(message.context ?? []),
      ...(repoMap.text ? [{ type: "repository-map", content: repoMap.text }] : []),
      ...(semanticContext ? [{ type: "local-semantic-retrieval", content: semanticContext }] : []),
    ];
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
    const recoveryContext = this.workspaces.recoveryContext ? await this.workspaces.recoveryContext(directory) : "";
    let repoMap = { text: "", entries: [] };
    if (message.task.role !== "release") {
      const query = `${message.objective.objective}\n${message.task.title}\n${message.task.instructions}`;
      try { repoMap = await this.buildRepoMap(directory, query, { maxCharacters: this.repoMapMaxCharacters }); } catch {}
    }
    let semanticContext = "";
    if (message.task.role !== "release" && this.retriever) {
      const query = `${message.objective.objective}\n${message.task.title}\n${message.task.instructions}`;
      try { semanticContext = await this.retriever.context(directory, message.objective.repository, query, { repositoryEntries: repoMap.entries }); } catch {}
    }
    const prompt = [
      "Execute only this assigned task, verify it, and report factual outcomes.",
      ...(recoveryContext ? [recoveryContext] : []),
      ...(scannerEvidence.length ? [`TRUSTED SCANNER EVIDENCE (mechanical output; do not claim checks beyond this evidence):\n${JSON.stringify(scannerEvidence)}`] : []),
      ...(repoMap.text ? [repoMap.text] : []),
      ...(semanticContext ? [`LOCAL SEMANTIC CONTEXT (retrieved from this exact repository revision):\n${semanticContext}`] : []),
    ].join("\n\n");
    const result = parseTaskResult(await this.agentRunner.invoke({
      objective: message.objective,
      task: message.task,
      directory,
      prompt,
    }));
    const hookResults = await runHooks(this.hooks, "before_checkpoint", this.hookHandlers, { message, directory, result });
    for (const hook of hookResults) {
      if (hook.action === "scanner" && hook.result.some((item) => item.status !== "passed")) throw new Error("Configured scanner hook did not pass");
      if (hook.action === "policy_check" && hook.result.required && !hook.result.approvalId && !hook.result.skipped) throw new Error("Policy hook required approval but did not create a durable request");
    }
    if (hookResults.some((item) => ["approval_request", "policy_check"].includes(item.action) && item.result?.approvalId)) return;
    const authoring = ["builder", "debugger"].includes(message.task.role);
    if (authoring && this.scannerSuite) {
      const secretScan = await this.scannerSuite.scan(directory, { names: ["gitleaks"] });
      if (secretScan.some((item) => item.status !== "passed")) throw new Error("Pre-push secret scan did not pass");
    }
    const checkpoint = authoring
      ? await this.workspaces.checkpoint(directory, message.objective, message.task)
      : await this.workspaces.reference(directory, message.objective, message.task);
    await this.sendControl({
      type: "result",
      objectiveId: message.objectiveId,
      taskId: message.task.id,
      status: "succeeded",
      ...result,
      ...checkpoint,
      ...(scannerEvidence.length ? { scannerEvidence } : {}),
    });
  }
}
