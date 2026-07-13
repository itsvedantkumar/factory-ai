import { z } from "zod";
import { ROLES } from "./routing.js";
import { approvalPolicies } from "./approval-policy.js";

const identifier = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const repository = z.string().url().max(2048).refine((value) => {
  const parsed = new URL(value);
  return parsed.protocol === "https:" && parsed.hostname === "github.com" && /^\/[^/]+\/[^/]+(?:\.git)?$/.test(parsed.pathname);
}, "Repository must be an HTTPS github.com repository URL");

const objectiveSchema = z.object({
  id: identifier,
  type: z.literal("objective"),
  objective: z.string().trim().min(3).max(12_000),
  repository,
  baseBranch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/).default("main"),
  workspaceContext: z.string().max(20_000).optional(),
  createdAt: z.string().datetime().optional(),
}).strict();

export const taskSchema = z.object({
  id: identifier,
  role: z.enum(ROLES),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(3).max(20_000),
  dependsOn: z.array(identifier).max(16).default([]),
  capabilities: z.array(identifier).max(12).default([]),
  complexity: z.enum(["simple", "complex"]).default("complex"),
}).strict();

const planSchema = z.object({
  executiveIntent: z.string().trim().min(1).max(4000).optional(),
  tasks: z.array(taskSchema).min(1).max(32),
}).strict();

const taskResultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  checks: z.array(z.string().trim().min(1).max(1000)).max(50),
  risks: z.array(z.string().trim().min(1).max(1000)).max(50),
  approval: z.enum(["approved", "changes_requested", "not_applicable"]),
  telemetry: z.object({
    model: z.string().min(1).max(300),
    steps: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    usage: z.object({
      inputTokens: z.number().int().nonnegative().default(0),
      cachedInputTokens: z.number().int().nonnegative().default(0),
      outputTokens: z.number().int().nonnegative().default(0),
    }),
  }).optional(),
}).strict();

const scannerEvidenceSchema = z.array(z.object({
  scanner: z.string().min(1).max(100),
  status: z.enum(["passed", "findings", "error"]),
  output: z.string().max(6000),
}).strict()).max(20);

const resultMessageSchema = taskResultSchema.extend({
  type: z.literal("result"),
  objectiveId: identifier,
  taskId: identifier,
  status: z.literal("succeeded"),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  scannerEvidence: scannerEvidenceSchema.optional(),
}).strict();

const approvalRequestMessageSchema = z.object({
  type: z.literal("approval_request"),
  objectiveId: identifier,
  approvalId: identifier,
  policy: z.enum(approvalPolicies),
  reason: z.string().trim().min(1).max(1000),
  actor: z.string().trim().min(1).max(200),
  requestedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  checkpoint: z.string().min(1).max(500).optional(),
}).strict().refine((value) => Date.parse(value.expiresAt) > Date.parse(value.requestedAt), {
  message: "Approval expiration must follow its request time",
  path: ["expiresAt"],
});

const approvalDecisionMessageSchema = z.object({
  type: z.literal("approval_decision"),
  objectiveId: identifier,
  approvalId: identifier,
  decision: z.enum(["approved", "denied", "expired"]),
  actor: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1000),
  decidedAt: z.string().datetime(),
  messageId: identifier,
}).strict();

export function parseObjective(value) {
  return objectiveSchema.parse(value);
}

export function parsePlan(value) {
  return planSchema.parse(value);
}

export function parseTaskResult(value) {
  return taskResultSchema.parse(value);
}

export function parseResultMessage(value) {
  return resultMessageSchema.parse(value);
}

export function parseApprovalRequestMessage(value) {
  return approvalRequestMessageSchema.parse(value);
}

export function parseApprovalDecisionMessage(value) {
  return approvalDecisionMessageSchema.parse(value);
}
