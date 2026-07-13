import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepositoryMap, mergeRepositoryContext } from "../src/repo-map.js";

async function fixture(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "factory-repo-map-"));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(directory, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return directory;
}

test("excludes generated and vendor paths from symbol extraction", async (t) => {
  const directory = await fixture({
    "src/auth.js": "export function authenticateUser() { return true; }\n",
    "vendor/copied.js": "export function authenticateVendor() {}\n",
    "dist/bundle.js": "function authenticateGenerated() {}\n",
    "src/client.generated.js": "export function authenticateGeneratedClient() {}\n",
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await buildRepositoryMap(directory, "authenticate user", { maxCharacters: 2000 });

  assert.match(result.text, /src\/auth\.js/);
  assert.doesNotMatch(result.text, /vendor|dist|generated/i);
});

test("respects the repository map character budget strictly", async (t) => {
  const files = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [
    `src/module-${index}.js`,
    `export function objectiveHandler${index}() { return "${"x".repeat(300)}"; }\n`,
  ]));
  const directory = await fixture(files);
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await buildRepositoryMap(directory, "objective handler", { maxCharacters: 700 });

  assert.ok(result.text.length > 0);
  assert.ok(result.text.length <= 700);
  assert.ok(result.entries.length < 30);
  assert.ok(result.entries.every((entry) => result.text.includes(entry.path)));
});

test("ranks files referenced by the objective above unrelated symbols", async (t) => {
  const directory = await fixture({
    "src/z-unrelated.js": "export function renderDashboard() {}\n",
    "src/payment-service.js": "export function processPayment() {}\n",
  });
  t.after(() => rm(directory, { recursive: true, force: true }));

  const result = await buildRepositoryMap(directory, "Fix processPayment in payment-service", { maxCharacters: 2000 });

  assert.ok(result.text.indexOf("src/payment-service.js") < result.text.indexOf("src/z-unrelated.js"));
});

test("merges map and semantic entries with deterministic path-range deduplication", () => {
  const repositoryEntries = [
    { path: "src/auth.js", startLine: 3, endLine: 3, content: "function authenticate() {}", score: 10 },
  ];
  const semanticPoints = [
    { score: 0.99, payload: { path: "src/auth.js", startLine: 3, endLine: 3, content: "duplicate" } },
    { score: 0.8, payload: { path: "src/session.js", startLine: 8, endLine: 12, content: "session" } },
    { score: 0.7, payload: { path: "src/session.js", startLine: 8, endLine: 12, content: "duplicate session" } },
  ];

  const first = mergeRepositoryContext(repositoryEntries, semanticPoints, 2000);
  const second = mergeRepositoryContext(repositoryEntries, [...semanticPoints].reverse(), 2000);

  assert.equal(first.semanticText, second.semanticText);
  assert.doesNotMatch(first.semanticText, /src\/auth\.js/);
  assert.equal(first.semanticText.match(/src\/session\.js/g)?.length, 1);
  assert.doesNotMatch(first.semanticText, /duplicate session/);
});
