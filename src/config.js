import path from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  SERVICE_BUS_NAMESPACE: z.string().min(3),
  SERVICE_BUS_QUEUE: z.string().min(1),
  KEY_VAULT_NAME: z.string().min(3),
  FACTORY_STATE_DIR: z.string().default("/opt/agent-factory/state"),
  FACTORY_WORKSPACE_DIR: z.string().default("/opt/agent-factory/workspaces"),
  FACTORY_REGISTRY: z.string().default("/opt/agent-factory/app/config/capabilities.json"),
  MAX_CONCURRENCY: z.coerce.number().int().min(1).max(3).default(3),
  TASK_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(1_800_000),
  MAX_DELIVERY_COUNT: z.coerce.number().int().min(2).max(20).default(8),
  AZURE_PRIMARY_API_KEY_SECRET: z.string().min(1).default("azure-primary-api-key"),
  AZURE_PRIMARY_BASE_URL_SECRET: z.string().min(1).default("azure-primary-base-url"),
  AZURE_SMALL_API_KEY_SECRET: z.string().min(1).default("azure-small-api-key"),
  AZURE_SMALL_BASE_URL_SECRET: z.string().min(1).default("azure-small-base-url"),
  GITHUB_TOKEN_SECRET: z.string().min(1).default("github-token"),
}).passthrough();

export function loadConfig(environment = process.env) {
  const env = environmentSchema.parse(environment);
  return {
    serviceBusFqdn: env.SERVICE_BUS_NAMESPACE.includes(".")
      ? env.SERVICE_BUS_NAMESPACE
      : `${env.SERVICE_BUS_NAMESPACE}.servicebus.windows.net`,
    queue: env.SERVICE_BUS_QUEUE,
    keyVaultUrl: `https://${env.KEY_VAULT_NAME}.vault.azure.net`,
    secretNames: {
      TEXTVED_AZURE_API_KEY: env.AZURE_PRIMARY_API_KEY_SECRET,
      TEXTVED_AZURE_BASE_URL: env.AZURE_PRIMARY_BASE_URL_SECRET,
      AZURE_OPENAI_API_KEY: env.AZURE_SMALL_API_KEY_SECRET,
      AZURE_OPENAI_BASE_URL: env.AZURE_SMALL_BASE_URL_SECRET,
      GH_TOKEN: env.GITHUB_TOKEN_SECRET,
    },
    stateDir: path.resolve(env.FACTORY_STATE_DIR),
    workspaceDir: path.resolve(env.FACTORY_WORKSPACE_DIR),
    registryPath: path.resolve(env.FACTORY_REGISTRY),
    concurrency: env.MAX_CONCURRENCY,
    timeoutMs: env.TASK_TIMEOUT_MS,
    maxDeliveryCount: env.MAX_DELIVERY_COUNT,
  };
}
