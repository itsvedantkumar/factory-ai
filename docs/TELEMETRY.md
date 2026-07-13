# Telemetry Core

Factory telemetry uses the dependency-free `src/telemetry.js` core. Its internal wire schema is versioned as `factory.telemetry.v1`; exporters adapt these records to an OpenTelemetry SDK or collector later.

## Integration API

```js
import { createTelemetry } from "./telemetry.js";

const telemetry = createTelemetry({
  exporter: async (record) => otlpAdapter.export(record),
  fallback: async (record) => activityStore.append(
    record.attributes["factory.objective.id"],
    record.attributes["factory.task.id"],
    record,
  ),
});

const span = telemetry.startSpan("model", {
  traceId,
  parentSpanId,
  objectiveId,
  taskId,
  role,
  modelRoute,
  attempt,
  toolCallId,
  messageId,
}, { inputTokens });

await span.end({ outputTokens, durationMs, cacheHit, statusClass: "ok" });
await telemetry.emitEvent("checkpoint", { traceId, objectiveId, taskId }, { statusClass: "ok" });
```

Supported operations are `model`, `tool`, `queue`, `checkpoint`, `scanner`, `watchdog`, and `release`. `startSpan()` returns the propagated `traceId`, a generated `spanId`, and an idempotent asynchronous `end()` method.

The exporter is optional. If it is absent or throws, the fallback receives the record. Both adapters are fail-safe: telemetry failures do not interrupt application work. Use the existing activity store as the durable JSONL fallback.

## Data Boundary

Only explicit correlation fields, numeric measurements, booleans, status classes, bounded error codes, provider names, and model routes are accepted. Unknown attributes are discarded. Prompt text, model responses, source code, tool or command output, secret fields, and repository URLs have no attribute mapping and must never be added to exporter adapters.

The OpenTelemetry GenAI-compatible attributes are `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.tool.call.id`, and `gen_ai.usage.*`. Content-bearing GenAI attributes are deliberately unsupported.
