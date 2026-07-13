import { z } from "zod";
import { parseObjective } from "./validation.js";

const acpObjectiveSchema = z.object({
  protocol: z.literal("acp"),
  version: z.literal("1.0"),
  method: z.literal("objective.submit"),
  params: z.object({
    id: z.string(),
    objective: z.string(),
    repository: z.string(),
    baseBranch: z.string().optional(),
  }).strict(),
}).strict();

export function translateAcpObjective(value, { enabled = false } = {}) {
  if (!enabled) throw new Error("ACP adapter is disabled");
  const request = acpObjectiveSchema.parse(value);
  return parseObjective({
    id: request.params.id,
    type: "objective",
    objective: request.params.objective,
    repository: request.params.repository,
    baseBranch: request.params.baseBranch,
  });
}
