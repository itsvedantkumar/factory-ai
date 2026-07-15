import test from "node:test";
import assert from "node:assert/strict";
import { dockerRunArguments, validateLocalCommand } from "../src/local-sandbox.js";
import { readFile } from "node:fs/promises";

test("local run sandbox mounts only the workspace and dependency volume", () => {
  const args = dockerRunArguments({ image: "factory-ai-local:1", workspaceVolume: "factory-work-1", volume: "factory-deps-1", network: "factory-isolated", uid: 501, gid: 20, command: ["npm", "test"], preview: false });
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("--cap-drop"));
  assert.ok(args.includes("ALL"));
  assert.ok(args.includes("factory-work-1:/workspace:rw"));
  assert.ok(args.includes("factory-isolated"));
  assert.equal(args.some((item) => item.includes("/work/app") || item.includes("/source")), false);
  assert.ok(args.includes("factory-deps-1:/workspace/node_modules:rw"));
  assert.equal(args.some((item) => item.includes(".ssh") || item.includes(".aws")), false);
  assert.equal(args.at(-2), "npm");
  assert.equal(args.at(-1), "test");
});

test("preview exposes only loopback development ports", () => {
  const args = dockerRunArguments({ image: "factory-ai-local:1", workspaceVolume: "factory-work-1", volume: "factory-deps-1", network: "factory-isolated", uid: 501, gid: 20, command: ["npm", "run", "dev"], preview: true });
  assert.ok(args.includes("127.0.0.1:3000:3000"));
  assert.ok(args.includes("127.0.0.1:5173:5173"));
});

test("local sandbox rejects shells, publishing, global installs, and mutating git", () => {
  assert.doesNotThrow(() => validateLocalCommand(["pnpm", "test"]));
  for (const command of [["sh", "-c", "id"], ["npm", "publish"], ["npm", "install", "-g", "x"], ["git", "reset", "--hard"], ["npx", "tool"]]) {
    assert.throws(() => validateLocalCommand(command));
  }
});

test("sandbox staging excludes common repository credential files", async () => {
  const script = await readFile(new URL("../bootstrap/local-sandbox-entrypoint.sh", import.meta.url), "utf8");
  for (const pattern of [".env*", ".npmrc", ".netrc", ".pypirc", "*.tfvars", "id_rsa*", ".aws", ".azure", ".kube", "*credentials*.json", "*secret*.json", "*.pem", "*.key", "*.p12", "*.pfx"]) {
    assert.ok(script.includes(pattern), `missing exclusion ${pattern}`);
  }
});
