import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEMETRY_SCHEMA_VERSION,
  createTelemetry,
  safeAttributes,
} from "../src/telemetry.js";

const context = {
  traceId: "0123456789abcdef0123456789abcdef",
  objectiveId: "objective-1",
  taskId: "build-1",
  role: "builder",
  modelRoute: "azureai-textved/gpt-5.6-sol",
  attempt: 2,
  toolCallId: "call-1",
  messageId: "message-1",
};

test("emits a versioned GenAI-compatible model span with safe measurements", async () => {
  const records = [];
  const telemetry = createTelemetry({
    exporter: async (record) => records.push(record),
    now: () => 1_000,
    createSpanId: () => "0123456789abcdef",
  });

  const span = telemetry.startSpan("model", context, {
    "gen_ai.provider.name": "azure.ai",
    "gen_ai.usage.input_tokens": 120,
  });
  await span.end({
    durationMs: 25,
    outputTokens: 30,
    cacheHit: true,
    statusClass: "ok",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].schemaVersion, TELEMETRY_SCHEMA_VERSION);
  assert.equal(records[0].recordType, "span");
  assert.equal(records[0].name, "gen_ai.chat");
  assert.equal(records[0].traceId, context.traceId);
  assert.equal(records[0].spanId, "0123456789abcdef");
  assert.equal(records[0].attributes["factory.objective.id"], "objective-1");
  assert.equal(records[0].attributes["factory.task.id"], "build-1");
  assert.equal(records[0].attributes["factory.agent.role"], "builder");
  assert.equal(records[0].attributes["gen_ai.request.model"], context.modelRoute);
  assert.equal(records[0].attributes["gen_ai.operation.name"], "chat");
  assert.equal(records[0].attributes["factory.attempt"], 2);
  assert.equal(records[0].attributes["gen_ai.tool.call.id"], "call-1");
  assert.equal(records[0].attributes["messaging.message.id"], "message-1");
  assert.equal(records[0].attributes["gen_ai.usage.input_tokens"], 120);
  assert.equal(records[0].attributes["gen_ai.usage.output_tokens"], 30);
  assert.equal(records[0].attributes["factory.duration_ms"], 25);
  assert.equal(records[0].attributes["factory.cache.hit"], true);
});

test("prompt, source, response, secrets, command output, and repository URLs cannot become attributes", () => {
  const forbidden = {
    prompt: "delete production",
    source: "const privateKey = 'hidden'",
    response: "proprietary model response",
    secret: "super-secret-token",
    commandOutput: "DATABASE_URL=hidden",
    repositoryUrl: "https://token@github.com/private/repo.git",
    "gen_ai.prompt": "prompt through semantic attribute",
    "gen_ai.response": "response through semantic attribute",
    "code.source": "source through semantic attribute",
  };

  const attributes = safeAttributes({ ...forbidden, inputTokens: 9 });
  const serialized = JSON.stringify(attributes);

  assert.deepEqual(attributes, { "gen_ai.usage.input_tokens": 9 });
  for (const value of Object.values(forbidden)) assert.equal(serialized.includes(value), false);
});

test("allowed attribute names still reject URLs and secret-shaped unbounded values", () => {
  assert.deepEqual(safeAttributes({
    modelRoute: "https://token@github.com/private/repo.git",
    errorCode: "Bearer_super-secret-token",
    statusClass: "everything worked and the password is hidden",
  }), {});
});

test("supports every planned operation as a stable span", async () => {
  const records = [];
  const telemetry = createTelemetry({ fallback: async (record) => records.push(record) });

  for (const kind of ["model", "tool", "queue", "checkpoint", "scanner", "watchdog", "release"]) {
    await telemetry.startSpan(kind, context).end({ statusClass: "ok" });
  }

  assert.deepEqual(records.map((record) => record.name), [
    "gen_ai.chat",
    "gen_ai.execute_tool",
    "factory.queue",
    "factory.checkpoint",
    "factory.scanner",
    "factory.watchdog",
    "factory.release",
  ]);
  assert.ok(records.every((record) => record.recordType === "span"));
});

test("emits point-in-time events with the same safe schema", async () => {
  const telemetry = createTelemetry();
  const record = await telemetry.emitEvent("checkpoint", context, { statusClass: "ok" });
  assert.equal(record.recordType, "event");
  assert.equal(record.attributes["factory.status.class"], "ok");
});

test("uses fallback when export is unavailable without breaking application flow", async () => {
  const records = [];
  const telemetry = createTelemetry({
    exporter: async () => { throw new Error("collector unavailable"); },
    fallback: async (record) => records.push(record),
  });

  const record = await telemetry.emitEvent("queue", context, { retryCount: 1 });

  assert.equal(record.attributes["factory.retry.count"], 1);
  assert.deepEqual(records, [record]);
});

test("rejects unknown operation kinds", () => {
  const telemetry = createTelemetry();
  assert.throws(() => telemetry.startSpan("custom", context), /Unknown telemetry operation/);
});
