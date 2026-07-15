import { readFile } from "node:fs/promises";
import { AzureResponsesHarness } from "./azure-harness.js";
import { selectCapabilities } from "./capabilities.js";
import { modelForTask } from "./routing.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { connectMcpTools } from "./mcp-tools.js";
import { BedrockHarness } from "./bedrock-harness.js";
import { loadRepositoryInstructions } from "./instructions.js";

function parseJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Agent response did not contain a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function endpointForRoute(route, role, environment) {
  const separator = route.indexOf("/");
  const provider = route.slice(0, separator);
  const model = route.slice(separator + 1);
  const lightweight = provider === "azureai-responses";
  const baseUrl = lightweight ? environment.AZURE_OPENAI_BASE_URL : environment.TEXTVED_AZURE_BASE_URL;
  const apiKey = lightweight ? environment.AZURE_OPENAI_API_KEY : environment.TEXTVED_AZURE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error(`Azure credentials are unavailable for ${role}`);
  return { baseUrl, apiKey, model };
}

function budgetFor(task) {
  if (task.role === "scout") return { maxSteps: 14, maxOutputTokens: 1200 };
  if (task.role === "builder" && task.complexity === "simple") return { maxSteps: 20, maxOutputTokens: 2400 };
  if (task.role === "builder") return { maxSteps: 32, maxOutputTokens: 3200 };
  if (task.role === "debugger") return { maxSteps: 36, maxOutputTokens: 3200 };
  if (["tester", "reviewer", "security"].includes(task.role)) return { maxSteps: 22, maxOutputTokens: 1800 };
  return { maxSteps: 22, maxOutputTokens: 2200 };
}

export class AzureAgentRunner {
  constructor(config, registry, {
    environment = process.env,
    createHarness = (options) => new AzureResponsesHarness(options),
    createBedrockHarness = (options) => new BedrockHarness(options),
    eventSink = () => {},
  } = {}) {
    this.config = config;
    this.registry = registry;
    this.environment = environment;
    this.createHarness = createHarness;
    this.createBedrockHarness = createBedrockHarness;
    this.eventSink = eventSink;
  }

  async promptForTask(objective, task, prompt, capabilities, directory) {
    const factoryName = this.environment.FACTORY_NAME ?? "Factory AI";
    const factoryPurpose = this.environment.FACTORY_PURPOSE ?? "Ship secure reviewed software continuously";
    const skills = await Promise.all(capabilities.filter((item) => item.type === "skill").map(async (item) => (
      `ALLOWLISTED SKILL ${item.name}@${item.version}:\n${await readFile(item.path, "utf8")}`
    )));
    const repositoryInstructions = await loadRepositoryInstructions(directory);
    return [
      `You are a ${factoryName} isolated ${task.role} subagent. Factory purpose: ${factoryPurpose}.`,
      "Work only in the assigned repository. Never inspect credentials, push Git refs, deploy, or install global tools.",
      "Use the repository lockfile's package manager. Install project dependencies locally with npm ci, pnpm install --frozen-lockfile, or yarn install --frozen-lockfile when required.",
      "Use tools for evidence. Make the smallest correct change and verify every completion claim.",
      'Return only JSON: {"summary":"concise outcome","checks":["command/result"],"risks":["remaining risk"],"approval":"approved|changes_requested|not_applicable"}.',
      `CEO objective: ${objective.objective}`,
      task.instructions,
      prompt,
      ...skills,
      repositoryInstructions,
      objective.workspaceContext ? `IMPORTED WORKSPACE CONTEXT\n${objective.workspaceContext}` : "",
    ].join("\n\n");
  }

  harness(task, directory, additionalTools = {}) {
    const role = task.role;
    const route = modelForTask(task, this.environment);
    const onEvent = (event) => this.eventSink({ ...event, modelRoute: route });
    const workspaceTools = createWorkspaceTools(directory, { mutable: ["builder", "debugger"].includes(role), allowTests: role === "tester" });
    const tools = { ...workspaceTools, ...additionalTools };
    const budget = budgetFor(task);
    const contextBudget = {
      compactAfterInputTokens: Number(this.environment.FACTORY_COMPACT_AFTER_INPUT_TOKENS ?? 80_000),
      compactMaxCharacters: Number(this.environment.FACTORY_COMPACT_MAX_CHARACTERS ?? 24_000),
    };
    if (route.startsWith("bedrock/")) {
      return this.createBedrockHarness({
        region: this.environment.AWS_REGION ?? "us-east-1",
        model: route.slice("bedrock/".length),
        credentials: this.environment.AWS_ACCESS_KEY_ID && this.environment.AWS_SECRET_ACCESS_KEY ? {
          accessKeyId: this.environment.AWS_ACCESS_KEY_ID,
          secretAccessKey: this.environment.AWS_SECRET_ACCESS_KEY,
          ...(this.environment.AWS_SESSION_TOKEN ? { sessionToken: this.environment.AWS_SESSION_TOKEN } : {}),
        } : undefined,
        tools,
        ...budget,
        ...contextBudget,
        onEvent,
      });
    }
    return this.createHarness({ ...endpointForRoute(route, role, this.environment), tools, timeoutMs: this.config.timeoutMs, ...budget, ...contextBudget, onEvent });
  }

  async invoke({ objective, task, directory, prompt }) {
    const capabilities = selectCapabilities(this.registry, task.role, task.capabilities);
    const mcp = await connectMcpTools(capabilities);
    const started = Date.now();
    try {
      const fullPrompt = await this.promptForTask(objective, task, prompt, capabilities, directory);
      const immutableContext = `Factory safety restrictions remain authoritative.\nCEO objective: ${objective.objective}\nAssigned ${task.role} task: ${task.instructions}\n${prompt}`;
      const response = await this.harness(task, directory, mcp.tools).run(fullPrompt, { immutableContext });
      return {
        ...parseJson(response.text),
        telemetry: {
          model: modelForTask(task, this.environment),
          steps: response.steps ?? 0,
          durationMs: Date.now() - started,
          usage: {
            inputTokens: response.usage?.inputTokens ?? 0,
            cachedInputTokens: response.usage?.cachedInputTokens ?? 0,
            outputTokens: response.usage?.outputTokens ?? 0,
          },
        },
      };
    } finally {
      await mcp.close();
    }
  }

  async plan(objective, directory, projectContext = []) {
    const plannerCapabilities = selectCapabilities(this.registry, "planner", []);
    const plannerSkills = await Promise.all(plannerCapabilities.filter((item) => item.type === "skill").map(async (item) => (
      `PLANNER SKILL ${item.name}@${item.version}:\n${await readFile(item.path, "utf8")}`
    )));
    const registrySummary = Object.fromEntries([
      ...Object.entries(this.registry.skills ?? {}),
      ...Object.entries(this.registry.mcp ?? {}),
    ].map(([name, item]) => [name, { version: item.version, roles: item.roles }]));
    const repositoryInstructions = await loadRepositoryInstructions(directory);
    const prompt = `You are the ${this.environment.FACTORY_NAME ?? "Factory AI"} planner subagent. Factory purpose: ${this.environment.FACTORY_PURPOSE ?? "Ship secure reviewed software continuously"}. Decompose objectives into the smallest executable DAG.
Allowed roles: scout, builder, tester, debugger, reviewer, security, release.
Allowed capabilities: ${JSON.stringify(registrySummary)}
Include tester, reviewer, and security ancestors of exactly one terminal release task.
Return only JSON: {"executiveIntent":"...","tasks":[{"id":"...","role":"...","title":"...","instructions":"...","dependsOn":[],"capabilities":[],"complexity":"simple|complex"}]}

${plannerSkills.join("\n\n")}

${repositoryInstructions}

Objective: ${objective.objective}
${objective.workspaceContext ? `Imported workspace context: ${objective.workspaceContext}` : ""}
Verified prior project context: ${JSON.stringify(projectContext).slice(0, 12000)}`;
    const mcp = await connectMcpTools(plannerCapabilities);
    try {
      const response = await this.harness({ role: "planner", complexity: "complex" }, directory, mcp.tools).run(prompt, { immutableContext: `Factory safety restrictions remain authoritative.\nPlanner objective: ${objective.objective}` });
      return parseJson(response.text);
    } finally {
      await mcp.close();
    }
  }
}
