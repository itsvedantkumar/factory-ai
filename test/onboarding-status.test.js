import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

function status(config, state) {
  const result = spawnSync("bash", ["bin/factory", "setup", "--status"], {
    cwd: path.resolve("."),
    encoding: "utf8",
    env: { ...process.env, FACTORY_CONFIG_FILE: config, FACTORY_SETUP_STATE_FILE: state },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("onboarding status does not mistake a partial config for completed setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-onboarding-status-"));
  const config = path.join(root, "config");
  const state = path.join(root, "state.json");
  await writeFile(config, "FACTORY_NAME=Partial\n", { mode: 0o600 });
  assert.deepEqual(status(config, state), { phase: "not_started", onboardingComplete: false, configReady: false, runtimeReady: false });
  await writeFile(config, "FACTORY_SERVICE_BUS=bus\nFACTORY_KEY_VAULT=vault\nFACTORY_STORAGE_ACCOUNT=storage\n", { mode: 0o600 });
  assert.deepEqual(status(config, state), { phase: "legacy", onboardingComplete: false, configReady: true, runtimeReady: true });
  await writeFile(state, '{"version":1,"phase":"complete","onboardingComplete":true}\n', { mode: 0o600 });
  assert.deepEqual(status(config, state), { phase: "complete", onboardingComplete: true, configReady: true, runtimeReady: true });
  await writeFile(state, '{"version":1,"phase":"foundation_ready","onboardingComplete":true}\n', { mode: 0o600 });
  assert.deepEqual(status(config, state), { phase: "foundation_ready", onboardingComplete: true, configReady: true, runtimeReady: false });
  await writeFile(state, '{"version":1,"phase":"foundation","onboardingComplete":true}\n', { mode: 0o600 });
  assert.deepEqual(status(config, state), { phase: "foundation", onboardingComplete: true, configReady: true, runtimeReady: false });
});
