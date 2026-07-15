import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("worker image includes common JavaScript repository tooling", async () => {
  const dockerfile = await readFile(new URL("../Dockerfile.worker", import.meta.url), "utf8");
  for (const dependency of ["python3", "make", "g++", "pkg-config", "pnpm@", "yarn@", "/opt/factory-toolchain"]) {
    assert.match(dockerfile, new RegExp(dependency.replace("+", "\\+")), `missing ${dependency}`);
  }
});
