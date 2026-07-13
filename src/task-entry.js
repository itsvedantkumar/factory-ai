#!/usr/bin/env node
import { AzureAgentRunner } from "./agent-runner.js";
import { loadRegistry } from "./registry.js";

const input = await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
});
const packet = JSON.parse(input);
process.title = `factory-ai-${packet.task?.role ?? packet.mode}`.slice(0, 63);
const registry = await loadRegistry("/opt/agent-factory/app/config/capabilities.json");
const runner = new AzureAgentRunner({ timeoutMs: 1_800_000 }, registry);
let result;
if (packet.mode === "plan") result = await runner.plan(packet.objective, "/workspace");
else if (packet.mode === "task") result = await runner.invoke({ ...packet, directory: "/workspace" });
else throw new Error(`Unsupported task mode: ${packet.mode}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
