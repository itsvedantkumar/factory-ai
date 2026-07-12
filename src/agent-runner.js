import { readFile } from "node:fs/promises";
import { AzureResponsesHarness } from "./azure-harness.js";
import { selectCapabilities } from "./capabilities.js";
import { modelForRole } from "./routing.js";
import { createWorkspaceTools } from "./workspace-tools.js";

function parseJson(text) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("Agent response did not contain a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

function endpointForRole(role, environment) {
  const lightweight = modelForRole(role).endsWith("/gpt-5.4");
  const baseUrl = lightweight ? environment.AZURE_OPENAI_BASE_URL : environment.TEXTVED_AZURE_BASE_URL;
  const apiKey = lightweight ? environment.AZURE_OPENAI_API_KEY : environment.TEXTVED_AZURE_API_KEY;
  if (!baseUrl || !apiKey) throw new Error(`Azure credentials are unavailable for ${role}`);
  return { baseUrl, apiKey, model: lightweight ? "gpt-5.4" : "gpt-5.6-sol" };
}

export class AzureAgentRunner {
  constructor(config, registry, {
    environment = process.env,
    createHarness = (options) => new AzureResponsesHarness(options),
  } = {}) {
    this.config = config;
    this.registry = registry;
    this.environment = environment;
    this.createHarness = createHarness;
  }

  async promptForTask(objective, task, prompt) {
    const capabilities = selectCapabilities(this.registry, task.role, task.capabilities);
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

  harness(role, directory) {
    return this.createHarness({
      ...endpointForRole(role, this.environment),
      tools: createWorkspaceTools(directory),
      timeoutMs: this.config.timeoutMs,
      maxSteps: role === "scout" ? 20 : 40,
    });
  }

  async invoke({ objective, task, directory, prompt }) {
    const response = await this.harness(task.role, directory).run(await this.promptForTask(objective, task, prompt));
    return parseJson(response.text);
  }

  async plan(objective, directory) {
    const registrySummary = Object.fromEntries([
      ...Object.entries(this.registry.skills ?? {}),
      ...Object.entries(this.registry.mcp ?? {}),
    ].map(([name, item]) => [name, { version: item.version, roles: item.roles }]));
    const prompt = `You are a planner subagent. Decompose the objective into a small executable DAG.
Objective: ${objective.objective}
Allowed roles: scout, builder, tester, debugger, reviewer, security, release.
Allowed capabilities: ${JSON.stringify(registrySummary)}
Include tester, reviewer, and security ancestors of exactly one terminal release task.
Return only JSON: {"executiveIntent":"...","tasks":[{"id":"...","role":"...","title":"...","instructions":"...","dependsOn":[],"capabilities":[]}]}`;
    const response = await this.harness("planner", directory).run(prompt);
    return parseJson(response.text);
  }
}
