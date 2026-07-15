import path from "node:path";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { run } from "./process.js";

const SECRET_ENVIRONMENT = [
  "TEXTVED_AZURE_BASE_URL",
  "TEXTVED_AZURE_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];
const SAFE_ENVIRONMENT = [
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "FACTORY_MODEL_SCOUT",
  "FACTORY_MODEL_PLANNER",
  "FACTORY_MODEL_BUILDER",
  "FACTORY_MODEL_TESTER",
  "FACTORY_MODEL_DEBUGGER",
  "FACTORY_MODEL_REVIEWER",
  "FACTORY_MODEL_SECURITY",
  "FACTORY_MODEL_RELEASE",
  "FACTORY_COMPACT_AFTER_INPUT_TOKENS",
  "FACTORY_COMPACT_MAX_CHARACTERS",
  "FACTORY_WATCHDOG_STALE_SECONDS",
  "FACTORY_VERSION",
];

function parseOutput(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Agent container returned no result");
  return JSON.parse(lines.at(-1));
}

async function prepareRepositoryMemory(memoryDir, repository) {
  const repositoryId = createHash("sha256").update(String(repository)).digest("hex").slice(0, 24);
  const repositoryMemory = path.join(path.resolve(memoryDir), repositoryId);
  await mkdir(repositoryMemory, { recursive: true, mode: 0o750 });
  await writeFile(path.join(repositoryMemory, "knowledge-graph.jsonl"), "", { flag: "a", mode: 0o640 });
  return repositoryMemory;
}

export class ContainerAgentRunner {
  constructor({ image, memoryDir, timeoutMs, activityStore, execute = run, prepareMemory = prepareRepositoryMemory, environment = process.env }) {
    if (!image) throw new Error("FACTORY_WORKER_IMAGE is required");
    this.image = image;
    this.memoryDir = memoryDir;
    this.timeoutMs = timeoutMs;
    this.activityStore = activityStore;
    this.execute = execute;
    this.prepareMemory = prepareMemory;
    this.environment = environment;
  }

  async executePacket(packet, directory) {
    const taskId = packet.task?.id ?? "planner";
    const name = `factory-ai-${packet.objective.id}-${packet.task?.id ?? "planner"}`.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-").slice(0, 63);
    const mutable = ["builder", "debugger"].includes(packet.task?.role);
    let memoryMount = [];
    if (this.memoryDir) {
      const repositoryMemory = await this.prepareMemory(this.memoryDir, packet.objective.repository ?? packet.objective.id);
      memoryMount = ["--volume", `${repositoryMemory}:/memory:${packet.task?.role === "planner" ? "rw" : "ro"}`];
    }
    const args = [
      "run", "-i", "--rm", "--name", name,
      "--read-only",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "512",
      "--memory", "8g",
      "--cpus", "2",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
      "--volume", `${path.resolve(directory)}:/workspace:${mutable ? "rw" : "ro"}`,
      ...memoryMount,
      "--workdir", "/workspace",
      "--env", "HOME=/tmp",
      ...SAFE_ENVIRONMENT.flatMap((nameValue) => ["--env", nameValue]),
      this.image,
    ];
    let writes = Promise.resolve();
    const record = (event) => {
      if (!this.activityStore) return;
      writes = writes.then(() => this.activityStore.append(packet.objective.id, taskId, event));
    };
    let stderrBuffer = "";
    const consumeEvents = (chunk) => {
      stderrBuffer += chunk.toString("utf8");
      for (;;) {
        const newline = stderrBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = stderrBuffer.slice(0, newline);
        stderrBuffer = stderrBuffer.slice(newline + 1);
        if (!line.startsWith("@factory-event ")) continue;
        try { record(JSON.parse(line.slice(15))); } catch {}
      }
    };
    record({ type: "container.started", container: name, role: packet.task?.role ?? packet.mode });
    try {
      const result = await this.execute("docker", args, {
        input: `${JSON.stringify({ ...packet, runtimeEnvironment: Object.fromEntries(SECRET_ENVIRONMENT.flatMap((nameValue) => this.environment[nameValue] ? [[nameValue, this.environment[nameValue]]] : [])) })}\n`,
        timeoutMs: this.timeoutMs,
        maxOutputBytes: 2_000_000,
        onStderr: consumeEvents,
      });
      record({ type: "container.completed", container: name, role: packet.task?.role ?? packet.mode });
      await writes;
      return parseOutput(result.stdout);
    } catch (error) {
      record({ type: "container.failed", container: name, role: packet.task?.role ?? packet.mode, error: String(error.message ?? error).slice(0, 500) });
      await writes;
      throw error;
    }
  }

  invoke({ objective, task, directory, prompt }) {
    return this.executePacket({ mode: "task", objective, task, prompt }, directory);
  }

  plan(objective, directory, context = []) {
    return this.executePacket({
      mode: "plan",
      objective,
      task: { id: "planner0", role: "planner", instructions: "Create the delivery graph.", capabilities: [] },
      context,
    }, directory);
  }
}
