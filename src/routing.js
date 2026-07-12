export const ROLES = Object.freeze([
  "scout",
  "planner",
  "builder",
  "tester",
  "debugger",
  "reviewer",
  "security",
  "release",
]);

const MODELS = Object.freeze({
  scout: "azureai-textved/factory-gpt-5-4-nano",
  tester: "azureai-responses/gpt-5.4",
  planner: "azureai-textved/gpt-5.6-sol",
  builder: "azureai-textved/factory-kimi-k2-7-code",
  debugger: "azureai-textved/gpt-5.6-sol",
  reviewer: "azureai-textved/gpt-5.6-sol",
  security: "azureai-textved/gpt-5.6-sol",
  release: "azureai-textved/gpt-5.6-sol",
});

export function modelForRole(role) {
  const model = MODELS[role];
  if (!model) throw new Error(`Unknown role: ${role}`);
  return model;
}
