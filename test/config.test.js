import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

test("requires separate control and agent queues", () => {
  const config = loadConfig({
    SERVICE_BUS_NAMESPACE: "factory-bus",
    CONTROL_QUEUE: "control-events",
    AGENT_QUEUE: "agent-tasks",
    RELEASE_QUEUE: "release-tasks",
    KEY_VAULT_NAME: "factory-vault",
  });
  assert.equal(config.controlQueue, "control-events");
  assert.equal(config.agentQueue, "agent-tasks");
  assert.notEqual(config.controlQueue, config.agentQueue);
  assert.equal(config.releaseQueue, "release-tasks");
  assert.equal(config.repoMapMaxCharacters, 8000);
});

test("validates the repository map character budget", () => {
  assert.throws(() => loadConfig({
    SERVICE_BUS_NAMESPACE: "factory-bus",
    KEY_VAULT_NAME: "factory-vault",
    FACTORY_REPO_MAP_MAX_CHARACTERS: "1999",
  }), /FACTORY_REPO_MAP_MAX_CHARACTERS/);
});

test("rejects a shared queue because control and execution must not compete", () => {
  assert.throws(() => loadConfig({
    SERVICE_BUS_NAMESPACE: "factory-bus",
    CONTROL_QUEUE: "shared",
    AGENT_QUEUE: "shared",
    KEY_VAULT_NAME: "factory-vault",
  }), /must be different/);
});

test("rejects release queue collisions and invalid hook configuration", () => {
  assert.throws(() => loadConfig({ SERVICE_BUS_NAMESPACE: "factory-bus", CONTROL_QUEUE: "control", AGENT_QUEUE: "agents", RELEASE_QUEUE: "agents", KEY_VAULT_NAME: "factory-vault" }), /must be different/);
  assert.throws(() => loadConfig({ SERVICE_BUS_NAMESPACE: "factory-bus", CONTROL_QUEUE: "control", AGENT_QUEUE: "agents", RELEASE_QUEUE: "release", KEY_VAULT_NAME: "factory-vault", FACTORY_HOOKS_JSON: '[{"point":"before_plan","action":"shell","input":{}}]' }), /Invalid FACTORY_HOOKS_JSON/);
});
