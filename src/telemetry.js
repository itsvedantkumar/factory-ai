import { randomBytes } from "node:crypto";

export const TELEMETRY_SCHEMA_VERSION = "factory.telemetry.v1";

const operationNames = Object.freeze({
  model: "gen_ai.chat",
  tool: "gen_ai.execute_tool",
  queue: "factory.queue",
  checkpoint: "factory.checkpoint",
  scanner: "factory.scanner",
  watchdog: "factory.watchdog",
  release: "factory.release",
});

const aliases = Object.freeze({
  objectiveId: "factory.objective.id",
  taskId: "factory.task.id",
  role: "factory.agent.role",
  modelRoute: "gen_ai.request.model",
  attempt: "factory.attempt",
  toolCallId: "gen_ai.tool.call.id",
  messageId: "messaging.message.id",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  durationMs: "factory.duration_ms",
  retryCount: "factory.retry.count",
  cacheHit: "factory.cache.hit",
  statusClass: "factory.status.class",
  errorCode: "error.type",
});

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const modelRoute = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const providerName = /^[a-z][a-z0-9._-]{0,63}$/;
const errorCode = /^[a-z][a-z0-9_.-]{0,63}$/;
const statusClasses = new Set(["ok", "error", "cancelled", "timeout", "retry"]);
const genAiOperations = Object.freeze({ model: "chat", tool: "execute_tool" });

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

const validators = Object.freeze({
  "factory.objective.id": (value) => typeof value === "string" && identifier.test(value),
  "factory.task.id": (value) => typeof value === "string" && identifier.test(value),
  "factory.agent.role": (value) => typeof value === "string" && identifier.test(value),
  "gen_ai.request.model": (value) => typeof value === "string" && modelRoute.test(value) && !value.includes("://"),
  "factory.attempt": nonNegativeInteger,
  "gen_ai.tool.call.id": (value) => typeof value === "string" && identifier.test(value),
  "messaging.message.id": (value) => typeof value === "string" && identifier.test(value),
  "gen_ai.provider.name": (value) => typeof value === "string" && providerName.test(value),
  "gen_ai.operation.name": (value) => value === "chat" || value === "execute_tool",
  "gen_ai.usage.input_tokens": nonNegativeInteger,
  "gen_ai.usage.output_tokens": nonNegativeInteger,
  "gen_ai.usage.cache_read.input_tokens": nonNegativeInteger,
  "factory.duration_ms": nonNegativeNumber,
  "factory.retry.count": nonNegativeInteger,
  "factory.cache.hit": (value) => typeof value === "boolean",
  "factory.status.class": (value) => statusClasses.has(value),
  "error.type": (value) => typeof value === "string" && errorCode.test(value),
});

export function safeAttributes(input = {}) {
  const result = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [inputName, value] of Object.entries(input)) {
    const name = aliases[inputName] ?? inputName;
    if (validators[name]?.(value)) result[name] = value;
  }
  return result;
}

function operationName(kind) {
  const name = operationNames[kind];
  if (!name) throw new Error(`Unknown telemetry operation: ${kind}`);
  return name;
}

function validHexId(value, length) {
  return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

export function createTelemetry(options = {}) {
  const {
    exporter,
    fallback,
    now = Date.now,
    createTraceId = () => randomBytes(16).toString("hex"),
    createSpanId = () => randomBytes(8).toString("hex"),
  } = options;

  function ids(context) {
    const traceId = validHexId(context?.traceId, 32) ? context.traceId : createTraceId();
    const spanId = createSpanId();
    if (!validHexId(traceId, 32) || !validHexId(spanId, 16)) throw new Error("Telemetry ID generators must return lowercase hexadecimal IDs");
    return {
      traceId,
      spanId,
      ...(validHexId(context?.parentSpanId, 16) ? { parentSpanId: context.parentSpanId } : {}),
    };
  }

  async function deliver(record) {
    if (typeof exporter === "function") {
      try {
        await exporter(record);
        return record;
      } catch {}
    }
    if (typeof fallback === "function") {
      try { await fallback(record); } catch {}
    }
    return record;
  }

  function baseRecord(recordType, kind, context) {
    const timestamp = new Date(now()).toISOString();
    return {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      recordType,
      name: operationName(kind),
      timestamp,
      ...ids(context),
    };
  }

  function startSpan(kind, context = {}, attributes = {}) {
    const startedAt = now();
    const base = baseRecord("span", kind, context);
    const initialAttributes = safeAttributes({
      ...context,
      ...attributes,
      ...(genAiOperations[kind] ? { "gen_ai.operation.name": genAiOperations[kind] } : {}),
    });
    let completion;
    return {
      traceId: base.traceId,
      spanId: base.spanId,
      end(endAttributes = {}) {
        if (!completion) {
          const measured = endAttributes.durationMs === undefined
            ? { durationMs: Math.max(0, now() - startedAt), ...endAttributes }
            : endAttributes;
          const record = {
            ...base,
            attributes: { ...initialAttributes, ...safeAttributes(measured) },
          };
          completion = deliver(record);
        }
        return completion;
      },
    };
  }

  function emitEvent(kind, context = {}, attributes = {}) {
    const record = {
      ...baseRecord("event", kind, context),
      attributes: safeAttributes({
        ...context,
        ...attributes,
        ...(genAiOperations[kind] ? { "gen_ai.operation.name": genAiOperations[kind] } : {}),
      }),
    };
    return deliver(record);
  }

  return Object.freeze({ startSpan, emitEvent });
}
