const explicit = /^(objective|goal|prompt|ask)\s*:\s*/i;
const delivery = /\b(fix|implement|build|create|change|remove|redesign|refactor|migrate|ship|deploy|integrate|upgrade|add)\b/i;
const imperativeDelivery = /^(?:please\s+)?(?:fix|implement|build|create|change|remove|redesign|refactor|migrate|ship|deploy|integrate|upgrade|add)\b/i;
const politeDelivery = /^(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:fix|implement|build|create|change|remove|redesign|refactor|migrate|ship|deploy|integrate|upgrade|add)\b/i;
const broadScope = /\b(end[- ]to[- ]end|across|workflow|feature|system|architecture|and|with tests|production)\b/i;
const question = /^(why|what|where|when|who|how|explain|show|inspect|find|check|diagnose)\b/i;

export function routePrompt(value) {
  const input = String(value ?? "").trim();
  const match = input.match(explicit);
  const text = (match ? input.slice(match[0].length) : input).trim();
  if (!text) throw new Error("Prompt is required");
  if (match) return { kind: /^(objective|goal)$/i.test(match[1]) ? "objective" : "action", text, reason: "explicit" };
  if (question.test(text)) return { kind: "action", text, reason: "question" };
  if (imperativeDelivery.test(text) || politeDelivery.test(text)) return { kind: "objective", text, reason: "delivery_intent" };
  if (delivery.test(text) && (broadScope.test(text) || text.length >= 140)) return { kind: "objective", text, reason: "delivery_scope" };
  return { kind: "action", text, reason: "quick" };
}
