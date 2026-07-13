import { z } from "zod";
import { approvalPolicies } from "./approval-policy.js";

export const HOOK_POINTS = Object.freeze(["before_plan", "after_plan", "before_tool_batch", "after_tool_batch", "before_checkpoint", "before_release"]);
export const HOOK_ACTIONS = Object.freeze(["scanner", "policy_check", "notification", "snapshot", "approval_request"]);

const point = z.enum(HOOK_POINTS);
const policy = z.enum(approvalPolicies);
const hookSchema = z.discriminatedUnion("action", [
  z.object({
    point,
    action: z.literal("scanner"),
    input: z.object({ scanners: z.array(z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)).max(20).optional() }).strict(),
  }).strict(),
  z.object({
    point,
    action: z.literal("policy_check"),
    input: z.object({ policies: z.array(policy).min(1).max(approvalPolicies.length) }).strict(),
  }).strict(),
  z.object({
    point,
    action: z.literal("notification"),
    input: z.object({ message: z.string().trim().min(1).max(1000) }).strict(),
  }).strict(),
  z.object({
    point,
    action: z.literal("snapshot"),
    input: z.object({ label: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional() }).strict(),
  }).strict(),
  z.object({
    point,
    action: z.literal("approval_request"),
    input: z.object({
      policy,
      reason: z.string().trim().min(1).max(1000),
      expiresAt: z.string().datetime().optional(),
    }).strict(),
  }).strict(),
]);

const hooksSchema = z.array(hookSchema).max(64).superRefine((hooks, context) => {
  for (const hookPoint of HOOK_POINTS) {
    const approvals = hooks.filter((hook) => hook.point === hookPoint && ["approval_request", "policy_check"].includes(hook.action));
    if (approvals.length > 1) context.addIssue({ code: z.ZodIssueCode.custom, message: `Only one aggregated approval hook is allowed at ${hookPoint}` });
  }
});

export function validateHooks(value) {
  return hooksSchema.parse(value);
}

export async function runHooks(hooks, hookPoint, handlers, context) {
  point.parse(hookPoint);
  const configured = validateHooks(hooks).filter((hook) => hook.point === hookPoint);
  const results = [];
  for (const hook of configured) {
    const handler = handlers[hook.action];
    if (typeof handler !== "function") throw new Error(`Missing built-in hook handler: ${hook.action}`);
    results.push({ action: hook.action, result: await handler(hook.input, context) });
  }
  return results;
}
