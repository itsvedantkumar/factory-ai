const SECRET_KEY = /token|secret|password|authorization|api.?key/i;

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[REDACTED]" : sanitize(item),
  ]));
}

export function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    factory: process.env.FACTORY_NAME ?? "Factory AI",
    service: process.title || "factory-ai",
    event,
    ...sanitize(fields),
  })}\n`);
}
