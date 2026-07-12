import { readFile } from "node:fs/promises";
import { AzureResponsesHarness } from "./azure-harness.js";
import { selectCapabilities } from "./capabilities.js";
import { modelForTask } from "./routing.js";
import { createWorkspaceTools } from "./workspace-tools.js";
import { connectMcpTools } from "./mcp-tools.js";
import { BedrockHarness } from "./bedrock-harness.js";

function parseJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Agent response did not contain a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function endpointForRoute(route, role, environment) {
  const [provider, model] = route.split("/");
  const lightweight = provider === "azureai-responses";
  const baseUrl = lightweight ? environment.AZURE_OPENAI_BASE_URL : environment.TEXTVED_AZURE_BASE_URL;
  const apiKey = lightweight ? environment.AZURE_OPENAI_API_KEY : environment.TEXTVED_AZURE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error(`Azure credentials are unavailable for ${role}`);
  return { baseUrl, apiKey, model };
}

export class AzureAgentRunner {
  constructor(config, registry, {
    environment = process.env,
    createHarness = (options) => new AzureResponsesHarness(options),
    createBedrockHarness = (options) => new BedrockHarness(options),
  } = {}) {
    this.config = config;
    this.registry = registry;
    this.environment = environment;
    this.createHarness = createHarness;
    this.createBedrockHarness = createBedrockHarness;
  }

  async promptForTask(objective, task, prompt, capabilities) {
    const skills = await Promise.all(capabilities.filter((item) => item.type === "skill").map(async (item) => (
      `ALLOWLISTED SKILL ${item.name}@${item.version}:\n${await readFile(item.path, "utf8")}`
    )));
    return [
      `You are the isolated ${task.role} subagent for CEO objective: ${objective.objective}`,
      task.instructions,
      "Work only in the assigned repository. Never inspect credentials, push Git refs, deploy, or install global tools.",
      "Use tools for evidence. Make the smallest correct change and verify every completion claim.",
      prompt,
      ...skills,
      'Return only JSON: {"summary":"concise outcome","checks":["command/result"],"risks":["remaining risk"],"approval":"approved|changes_requested|not_applicable"}.',
    ].join("\n\n");
  }

  harness(task, directory, additionalTools = {}) {
    const role = task.role;
    const route = modelForTask(task, this.environment);
    const tools = { ...createWorkspaceTools(directory), ...additionalTools };
    const maxSteps = role === "scout" ? 20 : 40;
    if (route.startsWith("bedrock/")) {
      return this.createBedrockHarness({
        region: this.environment.AWS_REGION ?? "us-east-1",
        model: route.slice("bedrock/".length),
        tools,
        maxSteps,
      });
    }
    return this.createHarness({ ...endpointForRoute(route, role, this.environment), tools, timeoutMs: this.config.timeoutMs, maxSteps });
  }

  async invoke({ objective, task, directory, prompt }) {
    const capabilities = selectCapabilities(this.registry, task.role, task.capabilities);
    const mcp = await connectMcpTools(capabilities);
    try {
      const response = await this.harness(task, directory, mcp.tools).run(
        await this.promptForTask(objective, task, prompt, capabilities),
      );
      return parseJson(response.text);
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
    const prompt = `You are a planner subagent. Decompose the objective into a small executable DAG.
Objective: ${objective.objective}
Verified prior project context: ${JSON.stringify(projectContext)}
Allowed roles: scout, builder, tester, debugger, reviewer, security, release.
Allowed capabilities: ${JSON.stringify(registrySummary)}
Include tester, reviewer, and security ancestors of exactly one terminal release task.
Return only JSON: {"executiveIntent":"...","tasks":[{"id":"...","role":"...","title":"...","instructions":"...","dependsOn":[],"capabilities":[],"complexity":"simple|complex"}]}

${plannerSkills.join("\n\n")}`;
    const mcp = await connectMcpTools(plannerCapabilities);
    try {
      const response = await this.harness({ role: "planner", complexity: "complex" }, directory, mcp.tools).run(prompt);
      return parseJson(response.text);
    } finally {
      await mcp.close();
    }
  }
}
