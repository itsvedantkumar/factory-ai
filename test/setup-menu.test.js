import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

test("onboarding emits every question exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-onboarding-"));
  const output = path.join(root, "choices.json");
  const answers = ["", "", "1", "", "", "n", "n", ""].join("\n");
  const result = spawnSync(process.execPath, ["src/setup-menu.js", output], { cwd: path.resolve("."), input: answers, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  for (const question of [
    "What should your factory be called?",
    "What should this factory build or optimize for?",
    "Which model provider should the factory configure?",
    "Azure infrastructure region",
    "GitHub Enterprise organization",
    "Deploy and start the runtime after storing credentials?",
    "Enable Telegram remote objective intake?",
  ]) {
    assert.equal(result.stdout.split(question).length - 1, 1, `question repeated: ${question}`);
  }
  const choices = JSON.parse(await readFile(output, "utf8"));
  assert.equal(choices.factoryName, "Factory AI");
  assert.equal(choices.factoryPurpose, "Ship secure reviewed software continuously");
  assert.equal(choices.provider, "azure");
  assert.equal(choices.deployNow, false);
});

test("onboarding resumes saved answers without asking questions again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-onboarding-"));
  const firstOutput = path.join(root, "first.json");
  const state = path.join(root, "state.json");
  const answers = ["My Factory", "Ship safely", "1", "centralindia", "", "n", "n", ""].join("\n");
  const first = spawnSync(process.execPath, ["src/setup-menu.js", firstOutput, state], { cwd: path.resolve("."), input: answers, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const resumedOutput = path.join(root, "resumed.json");
  const resumed = spawnSync(process.execPath, ["src/setup-menu.js", resumedOutput, state], { cwd: path.resolve("."), input: "", encoding: "utf8" });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Reusing saved onboarding answers/);
  assert.doesNotMatch(resumed.stdout, /What should/);
  assert.deepEqual(JSON.parse(await readFile(resumedOutput, "utf8")), JSON.parse(await readFile(firstOutput, "utf8")));
  const deployOutput = path.join(root, "deploy.json");
  const deploy = spawnSync(process.execPath, ["src/setup-menu.js", deployOutput, state, "--deploy"], { cwd: path.resolve("."), input: "", encoding: "utf8" });
  assert.equal(deploy.status, 0, deploy.stderr);
  assert.equal(JSON.parse(await readFile(deployOutput, "utf8")).deployNow, true);
  assert.doesNotMatch(deploy.stdout, /What should/);
});

test("onboarding leaves later credential input unread for the setup shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "factory-onboarding-"));
  const output = path.join(root, "choices.json");
  const script = `${JSON.stringify(process.execPath)} src/setup-menu.js ${JSON.stringify(output)}; IFS= read -r leftover; printf 'LEFTOVER=%s\\n' "$leftover"`;
  const answers = ["", "", "1", "", "", "n", "n", "credential-after-onboarding"].join("\n") + "\n";
  const result = spawnSync("bash", ["-c", script], { cwd: path.resolve("."), input: answers, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LEFTOVER=credential-after-onboarding/);
});
