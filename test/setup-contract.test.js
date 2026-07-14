import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("setup is resumable, version-pinned, preserving, and atomic", async () => {
  const cli = await readFile("bin/factory", "utf8");
  const host = await readFile("bootstrap/setup.sh", "utf8");
  assert.match(cli, /setup-state\.json/);
  assert.match(cli, /setup\.lock/);
  assert.match(cli, /ln -s "\$\$" "\$setup_lock"/);
  assert.match(cli, /commits\/v\$installed_version/);
  assert.doesNotMatch(cli, /commits\/main/);
  assert.match(cli, /grep -Ev '\^FACTORY_\(RESOURCE_GROUP/);
  assert.match(cli, /Major update .* requires an explicit migration release/);
  assert.match(cli, /Azure runtime did not verify/);
  assert.match(cli, /provider-doctor\.js/);
  assert.match(host, /worker_env=\$\(mktemp\)/);
  assert.match(host, /control_env=\$\(mktemp\)/);
  assert.match(host, /install -m 0640 -o root -g "\$FACTORY_USER" "\$worker_env" \/etc\/agent-factory\.env/);
  assert.match(host, /FACTORY_NAME=%s/);
  assert.match(host, /FACTORY_PURPOSE=%s/);
  const workerUnit = await readFile("bootstrap/agent-factory-worker.service", "utf8");
  assert.doesNotMatch(workerUnit, /EnvironmentFile=/);
  assert.match(workerUnit, /run-with-env\.js \/etc\/agent-factory\.env/);
});
