import { createHash } from "node:crypto";
import { z } from "zod";

export const FACTORY_USAGE_SCHEMA_VERSION = "factory.usage.v1";

const identifier = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  cacheReadInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
}).strict();
const recordSchema = z.object({
  schemaVersion: z.literal(FACTORY_USAGE_SCHEMA_VERSION),
  recordId: z.string().regex(/^[a-f0-9]{64}$/),
  recordedAt: z.string().datetime(),
  source: z.literal("factory-ai"),
  granularity: z.enum(["request", "task", "reconciliation"]),
  factoryId: identifier,
  sessionId: identifier,
  objectiveId: identifier,
  taskId: identifier,
  role: identifier,
  provider: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  model: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/),
  usage: usageSchema,
}).strict();

export function parseUsageRecord(value) { return recordSchema.parse(value); }

function opaque(prefix, value, length = 24) { return `${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, length)}`; }

export function createUsageRecordFromEvent({ factoryId, objectiveId, taskId, event }) {
  if (event?.type !== "model.request.completed" || !event.modelRoute || !event.occurredAt || !event.usage) return undefined;
  const separator = event.modelRoute.indexOf("/");
  if (separator < 1) return undefined;
  const inputTokens = event.usage.input_tokens ?? event.usage.inputTokens;
  const outputTokens = event.usage.output_tokens ?? event.usage.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return undefined;
  const usage = {
    inputTokens,
    outputTokens,
    ...((event.usage.input_tokens_details?.cached_tokens ?? event.usage.cacheReadInputTokens) ? { cacheReadInputTokens: event.usage.input_tokens_details?.cached_tokens ?? event.usage.cacheReadInputTokens } : {}),
    ...(event.usage.cacheWriteInputTokens ? { cacheWriteInputTokens: event.usage.cacheWriteInputTokens } : {}),
  };
  const sessionId = opaque("session", objectiveId);
  const opaqueTaskId = opaque("task", `${objectiveId}\0${taskId}`, 16);
  const identity = [FACTORY_USAGE_SCHEMA_VERSION, factoryId, objectiveId, taskId, event.occurredAt, event.step ?? 0, event.modelRoute, JSON.stringify(usage)].join("\0");
  return parseUsageRecord({ schemaVersion: FACTORY_USAGE_SCHEMA_VERSION, recordId: createHash("sha256").update(identity).digest("hex"), recordedAt: event.occurredAt, source: "factory-ai", granularity: "request", factoryId, sessionId, objectiveId: sessionId, taskId: opaqueTaskId, role: event.role ?? "unknown", provider: event.modelRoute.slice(0, separator), model: event.modelRoute.slice(separator + 1), usage });
}

export function createUsageRecords(states, { now = new Date(), retentionDays = 90, factoryId = "factory-default" } = {}) {
  const cutoff = now.getTime() - retentionDays * 86_400_000;
  const records = [];
  for (const state of states) {
    const objectiveId = state.objective?.id;
    if (!objectiveId) continue;
    const roles = new Map((state.tasks ?? []).map((task) => [task.id, task.role]));
    for (const [taskId, result] of Object.entries(state.results ?? {})) {
      if (result.status !== "succeeded" || !result.telemetry?.model || !result.completedAt || Date.parse(result.completedAt) < cutoff) continue;
      const separator = result.telemetry.model.indexOf("/");
      if (separator < 1) continue;
      const provider = result.telemetry.model.slice(0, separator);
      const model = result.telemetry.model.slice(separator + 1);
      const usage = {
        inputTokens: result.telemetry.usage?.inputTokens ?? 0,
        outputTokens: result.telemetry.usage?.outputTokens ?? 0,
        ...(result.telemetry.usage?.cachedInputTokens ? { cacheReadInputTokens: result.telemetry.usage.cachedInputTokens } : {}),
      };
      const identity = [FACTORY_USAGE_SCHEMA_VERSION, factoryId, objectiveId, taskId, result.commit ?? "no-commit", result.telemetry.model, result.completedAt].join("\0");
      records.push(parseUsageRecord({
        schemaVersion: FACTORY_USAGE_SCHEMA_VERSION,
        recordId: createHash("sha256").update(identity).digest("hex"),
        recordedAt: result.completedAt,
        source: "factory-ai",
        granularity: "task",
        factoryId,
        sessionId: opaque("session", objectiveId),
        objectiveId: opaque("session", objectiveId),
        taskId: opaque("task", `${objectiveId}\0${taskId}`, 16),
        role: roles.get(taskId) ?? "unknown",
        provider,
        model,
        usage,
      }));
    }
  }
  return records.sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.recordId.localeCompare(right.recordId));
}
