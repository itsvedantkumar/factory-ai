import test from "node:test";
import assert from "node:assert/strict";
import { formatObjectiveProgress, isAllowedChat, objectiveFromTelegram, parseTelegramCommand } from "../src/telegram.js";

test("parses remote objective commands into bounded submissions", () => {
  assert.deepEqual(parseTelegramCommand("/submit acme/app add health checks"), { type: "submit", repository: "acme/app", objective: "add health checks" });
  assert.deepEqual(parseTelegramCommand("/goal acme/app ship safely"), { type: "submit", repository: "acme/app", objective: "/goal ship safely" });
  assert.deepEqual(parseTelegramCommand("/loop acme/app fix issue 42"), { type: "submit", repository: "acme/app", objective: "/loop fix issue 42" });
  assert.deepEqual(parseTelegramCommand("/status"), { type: "status" });
  assert.deepEqual(parseTelegramCommand("/help"), { type: "help" });
});

test("supports default repository and natural-language prompts", () => {
  assert.deepEqual(parseTelegramCommand("/repo acme/app"), { type: "set_repository", repository: "acme/app" });
  assert.deepEqual(parseTelegramCommand("fix issue 42", "acme/app"), { type: "submit", repository: "acme/app", objective: "fix issue 42" });
  assert.deepEqual(parseTelegramCommand("/goal ship safely", "acme/app"), { type: "submit", repository: "acme/app", objective: "/goal ship safely" });
  assert.deepEqual(parseTelegramCommand("/recent"), { type: "recent" });
  assert.deepEqual(parseTelegramCommand("/objective abc-123"), { type: "objective", objectiveId: "abc-123" });
});

test("derives a deterministic objective ID from Telegram update ID", () => {
  const command = parseTelegramCommand("/loop acme/app fix it");
  const first = objectiveFromTelegram(42, command, new Date("2026-01-01T00:00:00Z"));
  const second = objectiveFromTelegram(42, command, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(first, second);
  assert.equal(first.id, "telegram-42");
});

test("rejects malformed repositories and oversized remote objectives", () => {
  assert.throws(() => parseTelegramCommand("/submit ../../etc bad"), /OWNER\/REPO/);
  assert.throws(() => parseTelegramCommand(`/submit acme/app ${"x".repeat(8001)}`), /too long/);
  assert.throws(() => parseTelegramCommand("hello"), /Unknown command/);
});

test("requires an explicit Telegram chat allowlist", () => {
  assert.equal(isAllowedChat("123", new Set(["123", "456"])), true);
  assert.equal(isAllowedChat("999", new Set(["123", "456"])), false);
  assert.equal(isAllowedChat("123", new Set()), false);
});

test("formats bounded agent progress and completion details", () => {
  const progress = formatObjectiveProgress({
    objective: { id: "objective-1", objective: "Ship feature" },
    status: "running",
    tasks: [{ id: "s", role: "scout", title: "Inspect" }, { id: "b", role: "builder", title: "Build" }],
    results: { s: { status: "succeeded" }, b: { status: "running" } },
    release: { url: "https://github.com/acme/app/pull/1" },
  });
  assert.match(progress, /1\/2 tasks complete/);
  assert.match(progress, /scout: succeeded/);
  assert.match(progress, /builder: running/);
  assert.match(progress, /pull\/1/);
});
