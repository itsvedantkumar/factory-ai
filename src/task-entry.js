#!/usr/bin/env node
import { AzureAgentRunner } from "./agent-runner.js";
import { loadRegistry } from "./registry.js";
import { createTelemetry } from "./telemetry.js";

const input = await new Promise((resolve, reject) => {
  let value = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { value += chunk; });
  process.stdin.on("end", () => resolve(value));
  process.stdin.on("error", reject);
});
const packet = JSON.parse(input);
const runtimeEnvironment = packet.runtimeEnvironment ?? {};
delete packet.runtimeEnvironment;
process.title = `factory-ai-${packet.task?.role ?? packet.mode}`.slice(0, 63);
const registry = await loadRegistry("/opt/agent-factory/app/config/capabilities.json");
let currentPhase = "starting";
const telemetry = createTelemetry({ exporter: async (record) => process.stderr.write(`@factory-event ${JSON.stringify({ type: "telemetry.recorded", telemetry: record, occurredAt: record.timestamp })}\n`) });
const eventSink = (event) => {
  if (event.type !== "agent.heartbeat") currentPhase = event.tool ? `${event.type}:${event.tool}` : event.type;
  process.stderr.write(`@factory-event ${JSON.stringify({ ...event, role: packet.task?.role ?? packet.mode, phase: currentPhase, occurredAt: new Date().toISOString() })}\n`);
  const kind = event.type?.startsWith("model.") ? "model" : event.type?.startsWith("tool.") ? "tool" : null;
  if (kind) void telemetry.emitEvent(kind, { objectiveId: packet.objective.id, taskId: packet.task?.id ?? "planner0", role: packet.task?.role ?? packet.mode }, { statusClass: event.type.endsWith("failed") ? "error" : event.type.endsWith("retry") ? "retry" : "ok", attempt: event.attempt ?? event.step ?? 0, inputTokens: event.usage?.input_tokens ?? event.usage?.inputTokens, outputTokens: event.usage?.output_tokens ?? event.usage?.outputTokens });
};
const runner = new AzureAgentRunner({ timeoutMs: 1_800_000 }, registry, { eventSink, environment: { ...process.env, ...runtimeEnvironment } });
const heartbeat = setInterval(() => eventSink({ type: "agent.heartbeat", role: packet.task?.role ?? packet.mode, phase: currentPhase }), 15_000);
heartbeat.unref();
try {
  eventSink({ type: "agent.started", role: packet.task?.role ?? packet.mode });
  let result;
  if (packet.mode === "plan") result = await runner.plan(packet.objective, "/workspace", packet.context ?? []);
  else if (packet.mode === "task") result = await runner.invoke({ ...packet, directory: "/workspace" });
  else throw new Error(`Unsupported task mode: ${packet.mode}`);
  eventSink({ type: "agent.completed", role: packet.task?.role ?? packet.mode });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  eventSink({ type: "agent.failed", role: packet.task?.role ?? packet.mode, error: String(error.message ?? error).slice(0, 500) });
  throw error;
} finally {
  clearInterval(heartbeat);
}
