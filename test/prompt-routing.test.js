import test from "node:test";
import assert from "node:assert/strict";
import { routePrompt } from "../src/prompt-routing.js";

test("explicit objective and prompt prefixes override automatic routing", () => {
  assert.deepEqual(routePrompt("objective: rebuild authentication"), { kind: "objective", text: "rebuild authentication", reason: "explicit" });
  assert.deepEqual(routePrompt("prompt: explain authentication"), { kind: "action", text: "explain authentication", reason: "explicit" });
});

test("delivery work becomes an objective while questions remain quick actions", () => {
  assert.equal(routePrompt("Implement registration, billing, checkout, tests, and deployment").kind, "objective");
  assert.equal(routePrompt("Fix the login button").kind, "objective");
  assert.equal(routePrompt("Could you implement password reset?").kind, "objective");
  assert.equal(routePrompt("Why does the checkout test fail?").kind, "action");
  assert.equal(routePrompt("Show me how authentication works").kind, "action");
});

test("empty routed prompts are rejected", () => {
  assert.throws(() => routePrompt("objective:   "), /Prompt is required/);
});
