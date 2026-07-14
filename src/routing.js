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
  tester: "azureai-textved/gpt-5.4",
  planner: "azureai-textved/gpt-5.6-sol",
  builder: "azureai-textved/gpt-5.5",
  debugger: "azureai-textved/gpt-5.6-sol",
  reviewer: "azureai-textved/gpt-5.6-sol",
  security: "azureai-textved/gpt-5.6-sol",
  release: "azureai-textved/gpt-5.6-sol",
});

const PROVIDERS = new Set(["azureai-textved", "azureai-responses", "bedrock"]);

export function validateModelRoute(route) {
  if (typeof route !== "string" || route.length > 240 || !/^[A-Za-z0-9._:/-]+$/.test(route)) throw new Error("Invalid model route");
  const separator = route.indexOf("/");
  if (separator < 1 || !PROVIDERS.has(route.slice(0, separator))) throw new Error("Unsupported model provider");
  if (separator === route.length - 1) throw new Error("Invalid model route");
  return route;
}

export function modelForRole(role, environment = process.env) {
  const model = environment[`FACTORY_MODEL_${role.toUpperCase()}`] ?? MODELS[role];
  if (!model) throw new Error(`Unknown role: ${role}`);
  return validateModelRoute(model);
}

export function modelForTask(task, environment = process.env) {
  if (task.role === "builder" && task.complexity === "simple" && !environment.FACTORY_MODEL_BUILDER) {
    return "azureai-textved/factory-kimi-k2-7-code";
  }
  return modelForRole(task.role, environment);
}
