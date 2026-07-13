import test from "node:test";
import assert from "node:assert/strict";
import { validateGraph, validateDeliveryGraph, readyTasks } from "../src/task-graph.js";

const tasks = [
  { id: "scout", dependsOn: [] },
  { id: "build", dependsOn: ["scout"] },
  { id: "review", dependsOn: ["build"] },
];

test("finds ready tasks from dependency state", () => {
  validateGraph(tasks);
  assert.deepEqual(readyTasks(tasks, {}), ["scout"]);
  assert.deepEqual(readyTasks(tasks, { scout: { status: "succeeded" } }), ["build"]);
});

test("does not redispatch running tasks", () => {
  assert.deepEqual(readyTasks(tasks, { scout: { status: "running" } }), []);
});

test("rejects cycles and missing dependencies", () => {
  assert.throws(() => validateGraph([{ id: "a", dependsOn: ["b"] }]), /unknown task/);
  assert.throws(() => validateGraph([
    { id: "a", dependsOn: ["b"] },
    { id: "b", dependsOn: ["a"] },
  ]), /cycle/);
});

test("requires tester, reviewer, and security approval paths before terminal release", () => {
  const delivery = [
    { id: "build000", role: "builder", dependsOn: [] },
    { id: "test0000", role: "tester", dependsOn: ["build000"] },
    { id: "review00", role: "reviewer", dependsOn: ["build000"] },
    { id: "secure00", role: "security", dependsOn: ["build000"] },
    { id: "release0", role: "release", dependsOn: ["test0000", "review00", "secure00"] },
  ];
  assert.doesNotThrow(() => validateDeliveryGraph(delivery));
  assert.throws(() => validateDeliveryGraph([
    ...delivery.filter((task) => !["security", "release"].includes(task.role)),
    { id: "release0", role: "release", dependsOn: ["test0000", "review00"] },
  ]), /security/);
  assert.throws(() => validateDeliveryGraph([
    ...delivery.slice(0, -1),
    { id: "release0", role: "release", dependsOn: ["test0000", "review00"] },
  ]), /security.*ancestor/);
});
