import { z } from "zod";
import { ROLES } from "./routing.js";

const identifier = z.string().min(3).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
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
  createdAt: z.string().datetime().optional(),
}).strict();

export const taskSchema = z.object({
  id: identifier,
  role: z.enum(ROLES),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().min(3).max(20_000),
  dependsOn: z.array(identifier).max(16).default([]),
  capabilities: z.array(identifier).max(12).default([]),
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
}).strict();

export const workMessageSchema = z.object({
  type: z.literal("task"),
  objectiveId: identifier,
  task: taskSchema,
}).strict();

const resultMessageSchema = taskResultSchema.extend({
  type: z.literal("result"),
  objectiveId: identifier,
  taskId: identifier,
  status: z.literal("succeeded"),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
}).strict();

export function parseObjective(value) {
  return objectiveSchema.parse(value);
}

export function parsePlan(value) {
  return planSchema.parse(value);
}

export function parseWorkMessage(value) {
  return workMessageSchema.parse(value);
}

export function parseTaskResult(value) {
  return taskResultSchema.parse(value);
}

export function parseResultMessage(value) {
  return resultMessageSchema.parse(value);
}
