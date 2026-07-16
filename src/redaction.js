export function redactSecrets(value) {
  return String(value ?? "")
    .replaceAll(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|xox[a-z]-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    .replaceAll(/\bbot\d+:[A-Za-z0-9_-]{20,}\b/g, "bot[REDACTED]")
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replaceAll(/((?:Bearer|Basic)\s+)\S+/gi, "$1[REDACTED]")
    .replaceAll(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replaceAll(/-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
}
