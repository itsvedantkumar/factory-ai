import test from "node:test";
import assert from "node:assert/strict";
import { selectCapabilities } from "../src/capabilities.js";

const registry = {
  skills: {
    search: { version: "1.0.0", path: "/opt/caps/search/SKILL.md", roles: ["scout"] },
    review: { version: "2.1.0", path: "/opt/caps/review/SKILL.md", roles: ["reviewer"] },
  },
  mcp: {
    github: { version: "1.4.2", command: ["/usr/local/bin/github-mcp", "stdio"], roles: ["reviewer"] },
  },
};

test("selects only requested, role-allowed, pinned capabilities", () => {
  const selected = selectCapabilities(registry, "reviewer", ["review", "github"]);
  assert.deepEqual(selected.map((item) => item.name), ["review", "github"]);
});

test("rejects unknown, unpinned, and cross-role capabilities", () => {
  assert.throws(() => selectCapabilities(registry, "scout", ["github"]), /not allowed/);
  assert.throws(() => selectCapabilities(registry, "scout", ["arbitrary-package"]), /Unknown capability/);
  assert.throws(() => selectCapabilities({ skills: { bad: { path: "/tmp/x", roles: ["scout"] } }, mcp: {} }, "scout", ["bad"]), /pinned/);
});
