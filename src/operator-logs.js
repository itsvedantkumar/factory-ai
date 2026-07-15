const ALLOWED_FIELDS = new Set(["timestamp", "level", "factory", "service", "event", "objectiveId", "taskId", "type", "messageId", "source", "deliveryCount", "error", "signal", "queue", "concurrency"]);

function redact(value) {
  return String(value)
    .replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|xox[a-z]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replaceAll(/\bbot\d+:[A-Za-z0-9_-]{20,}\b/g, "bot[REDACTED]")
    .replaceAll(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}

export function safeOperatorLogs(raw, { maxCharacters = 250_000 } = {}) {
  const output = [];
  for (const line of String(raw).split("\n")) {
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== "object" || typeof parsed.event !== "string") continue;
    const safe = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (ALLOWED_FIELDS.has(key) && ["string", "number", "boolean"].includes(typeof value)) safe[key] = typeof value === "string" ? redact(value) : value;
    }
    output.push(JSON.stringify(safe));
  }
  return output.join("\n").slice(-maxCharacters);
}
