import { createHash, randomUUID } from "node:crypto";

export function submissionId(repository, objective, { forceNew = false } = {}) {
  if (forceNew) return randomUUID();
  return `objective-${createHash("sha256").update(`${repository}\0${objective.trim()}`).digest("hex").slice(0, 32)}`;
}
