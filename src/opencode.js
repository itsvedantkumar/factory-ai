import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { selectCapabilities } from "./capabilities.js";
import { modelForRole } from "./routing.js";
import { run } from "./process.js";

function extractResponse(stdout) {
  const text = stdout.split("\n").flatMap((line) => {
    try {
      const event = JSON.parse(line);
      return [event.part?.text, event.text].filter(Boolean);
    } catch {
      return [line];
    }
  }).join("\n");
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("OpenCode response did not contain a JSON object");
  return JSON.parse(text.slice(start, end + 1));
}

export class OpenCodeRunner {
  constructor(config, registry) {
    this.config = config;
    this.registry = registry;
  }

  async taskConfig(objectiveId, task, capabilities) {
    const base = JSON.parse(await readFile(this.config.openCodeConfigPath, "utf8"));
    base.mcp = Object.fromEntries(capabilities.filter((item) => item.type === "mcp").map((item) => [
      item.name,
      { type: "local", command: item.command, enabled: true, env: item.environment ?? {} },
    ]));
    const output = path.join(this.config.stateDir, objectiveId, `opencode-${task.id}.json`);
    await writeFile(output, `${JSON.stringify(base, null, 2)}\n`, { mode: 0o640 });
    return output;
  }

  async invoke({ objective, task, directory, prompt }) {
    const capabilities = selectCapabilities(this.registry, task.role, task.capabilities);
    const skillInstructions = await Promise.all(capabilities.filter((item) => item.type === "skill").map(async (item) => (
      `\nALLOWLISTED SKILL ${item.name}@${item.version}:\n${await readFile(item.path, "utf8")}`
    )));
    const configPath = await this.taskConfig(objective.id, task, capabilities);
    const completePrompt = [
      `You are the isolated ${task.role} subagent for CEO objective: ${objective.objective}`,
      task.instructions,
      "Work only in the current repository. Never install global tools or invoke package runners without --no-install.",
      "Commit coherent checkpoints after each validated milestone. The trusted runtime pushes only the assigned task branch; agent-side pushes are denied.",
      prompt,
      ...skillInstructions,
      'Return only JSON: {"summary":"concise outcome","checks":["command/result"],"risks":["remaining risk"],"approval":"approved|changes_requested|not_applicable"}. Tester, reviewer, and security roles must explicitly approve or request changes; other roles use not_applicable.',
    ].join("\n\n");
    const branch = `agent-factory/${objective.id}/${task.id}`;
    const pushCheckpoint = () => run("git", [
      "-C", directory, "push", "origin", `HEAD:refs/heads/${branch}`,
    ], { timeoutMs: 60_000 }).catch(() => {});
    const pushTimer = setInterval(pushCheckpoint, 60_000);
    pushTimer.unref();
    try {
      const result = await run(this.config.openCodeBin, [
        "run",
        "--model", modelForRole(task.role),
        "--format", "json",
        completePrompt,
      ], {
        cwd: directory,
        timeoutMs: this.config.timeoutMs,
        env: { OPENCODE_CONFIG: configPath },
      });
      await pushCheckpoint();
      return extractResponse(result.stdout);
    } finally {
      clearInterval(pushTimer);
    }
  }

  async plan(objective, directory) {
    const task = {
      id: "cto-plan",
      role: "planner",
      capabilities: [],
    };
    const configPath = await this.taskConfig(objective.id, task, []);
    const registrySummary = Object.fromEntries([
      ...Object.entries(this.registry.skills ?? {}),
      ...Object.entries(this.registry.mcp ?? {}),
    ].map(([name, item]) => [name, { version: item.version, roles: item.roles }]));
    const prompt = `Act as CTO. Decompose this objective into a small executable DAG for isolated agents.
Objective: ${objective.objective}
Allowed roles: scout, builder, tester, debugger, reviewer, security, release.
Allowed capabilities: ${JSON.stringify(registrySummary)}
Use only capability names allowed for each role. Include tester, reviewer, and security tasks as ancestors of exactly one terminal release task. The release task integrates approved checkpoints and creates the PR. Keep tasks concrete and minimize count.
Return only JSON: {"executiveIntent":"...","tasks":[{"id":"...","role":"...","title":"...","instructions":"...","dependsOn":[],"capabilities":[]}]}`;
    const result = await run(this.config.openCodeBin, [
      "run", "--model", modelForRole("planner"), "--format", "json", prompt,
    ], {
      cwd: directory,
      timeoutMs: this.config.timeoutMs,
      env: { OPENCODE_CONFIG: configPath },
    });
    return extractResponse(result.stdout);
  }
}
