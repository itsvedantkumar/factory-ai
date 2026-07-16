import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release ships an offline attestation bundle used by the launcher", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../bin/factory", import.meta.url), "utf8");

  assert.match(workflow, /id:\s*attest/);
  assert.match(workflow, /steps\.attest\.outputs\.bundle-path/);
  assert.match(workflow, /dist\/attestation\.json/);
  assert.match(launcher, /attestation\.json/);
  assert.match(launcher, /--bundle\s+"\$cache\/attestation\.json"/);
});
