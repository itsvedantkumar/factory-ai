import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("requires separate control and agent queues", () => {
  const config = loadConfig({
    SERVICE_BUS_NAMESPACE: "factory-bus",
    CONTROL_QUEUE: "control-events",
    AGENT_QUEUE: "agent-tasks",
    KEY_VAULT_NAME: "factory-vault",
  });
  assert.equal(config.controlQueue, "control-events");
  assert.equal(config.agentQueue, "agent-tasks");
  assert.notEqual(config.controlQueue, config.agentQueue);
});

test("rejects a shared queue because control and execution must not compete", () => {
  assert.throws(() => loadConfig({
    SERVICE_BUS_NAMESPACE: "factory-bus",
    CONTROL_QUEUE: "shared",
    AGENT_QUEUE: "shared",
    KEY_VAULT_NAME: "factory-vault",
  }), /must be different/);
});
