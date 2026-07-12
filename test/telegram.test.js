import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedChat, objectiveFromTelegram, parseTelegramCommand } from "../src/telegram.js";

test("parses remote objective commands into bounded submissions", () => {
  assert.deepEqual(parseTelegramCommand("/submit acme/app add health checks"), { type: "submit", repository: "acme/app", objective: "add health checks" });
  assert.deepEqual(parseTelegramCommand("/goal acme/app ship safely"), { type: "submit", repository: "acme/app", objective: "/goal ship safely" });
  assert.deepEqual(parseTelegramCommand("/loop acme/app fix issue 42"), { type: "submit", repository: "acme/app", objective: "/loop fix issue 42" });
  assert.deepEqual(parseTelegramCommand("/status"), { type: "status" });
  assert.deepEqual(parseTelegramCommand("/help"), { type: "help" });
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
