import test from "node:test";
import assert from "node:assert/strict";
import { translateAcpObjective } from "../src/acp-adapter.js";

const request = {
  protocol: "acp",
  version: "1.0",
  method: "objective.submit",
  params: {
    id: "acp-request-1",
    objective: "Add an authenticated health endpoint",
    repository: "https://github.com/example/service.git",
    baseBranch: "main",
  },
};

test("translates an enabled ACP request into a validated objective packet", () => {
  assert.deepEqual(translateAcpObjective(request, { enabled: true }), {
    id: "acp-request-1",
    type: "objective",
    objective: "Add an authenticated health endpoint",
    repository: "https://github.com/example/service.git",
    baseBranch: "main",
  });
});

test("keeps ACP disabled unless explicitly enabled", () => {
  assert.throws(() => translateAcpObjective(request), /disabled/);
});

test("rejects privileged capabilities and extra request fields", () => {
  for (const field of ["capabilities", "tools", "docker", "keyVault", "githubToken", "release"]) {
    assert.throws(() => translateAcpObjective({
      ...request,
      params: { ...request.params, [field]: field === "capabilities" ? ["docker"] : true },
    }, { enabled: true }));
  }
  assert.throws(() => translateAcpObjective({ ...request, command: ["docker", "run"] }, { enabled: true }));
});

test("uses the control-plane objective validation at the edge", () => {
  assert.throws(() => translateAcpObjective({
    ...request,
    params: { ...request.params, repository: "file:///var/run/docker.sock" },
  }, { enabled: true }), /github\.com/);
  assert.throws(() => translateAcpObjective({
    ...request,
    params: { ...request.params, objective: "x" },
  }, { enabled: true }));
});
