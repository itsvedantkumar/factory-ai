import path from "node:path";
import { run } from "./process.js";

const AZURE_ENVIRONMENT = [
  "TEXTVED_AZURE_BASE_URL",
  "TEXTVED_AZURE_API_KEY",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
];

function parseOutput(stdout) {
  const lines = stdout.trim().split("\n").filter(Boolean);
  if (lines.length === 0) throw new Error("Agent container returned no result");
  return JSON.parse(lines.at(-1));
}

export class ContainerAgentRunner {
  constructor({ image, timeoutMs, execute = run }) {
    if (!image) throw new Error("FACTORY_WORKER_IMAGE is required");
    this.image = image;
    this.timeoutMs = timeoutMs;
    this.execute = execute;
  }

  async executePacket(packet, directory) {
    const name = `agent-${packet.objective.id}-${packet.task?.id ?? "planner"}`.toLowerCase().replaceAll(/[^a-z0-9_.-]/g, "-").slice(0, 63);
    const args = [
      "run", "--rm", "--name", name,
      "--read-only",
      "--user", `${process.getuid()}:${process.getgid()}`,
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "512",
      "--memory", "8g",
      "--cpus", "2",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=1g",
      "--volume", `${path.resolve(directory)}:/workspace:rw`,
      "--workdir", "/workspace",
      "--env", "HOME=/tmp",
      ...AZURE_ENVIRONMENT.flatMap((nameValue) => ["--env", nameValue]),
      this.image,
    ];
    const result = await this.execute("docker", args, {
      input: `${JSON.stringify(packet)}\n`,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: 2_000_000,
    });
    return parseOutput(result.stdout);
  }

  invoke({ objective, task, directory, prompt }) {
    return this.executePacket({ mode: "task", objective, task, prompt }, directory);
  }

  plan(objective, directory) {
    return this.executePacket({
      mode: "plan",
      objective,
      task: { id: "planner0", role: "planner", instructions: "Create the delivery graph.", capabilities: [] },
    }, directory);
  }
}
