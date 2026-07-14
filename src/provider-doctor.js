#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { AzureResponsesHarness } from "./azure-harness.js";
import { BedrockHarness } from "./bedrock-harness.js";
import { loadConfig } from "./config.js";
import { modelForTask } from "./routing.js";
import { loadRuntimeSecrets } from "./secrets.js";

const roles = ["scout", "planner", "builder", "tester", "debugger", "reviewer", "security", "release"];

export async function probeProviders(environment, {
  createAzure = (options) => new AzureResponsesHarness(options),
  createBedrock = (options) => new BedrockHarness(options),
} = {}) {
  const routes = [...new Set(roles.map((role) => modelForTask({ role, complexity: "complex" }, environment)))];
  const results = [];
  for (const route of routes) {
    const separator = route.indexOf("/");
    const provider = route.slice(0, separator);
    const model = route.slice(separator + 1);
    let harness;
    if (provider === "bedrock") {
      if (!environment.AWS_ACCESS_KEY_ID || !environment.AWS_SECRET_ACCESS_KEY) throw new Error(`Bedrock credentials are unavailable for ${route}`);
      harness = createBedrock({
        region: environment.AWS_REGION ?? "us-east-1",
        model,
        credentials: { accessKeyId: environment.AWS_ACCESS_KEY_ID, secretAccessKey: environment.AWS_SECRET_ACCESS_KEY, ...(environment.AWS_SESSION_TOKEN ? { sessionToken: environment.AWS_SESSION_TOKEN } : {}) },
        tools: {}, maxSteps: 1, maxOutputTokens: 32,
      });
    } else {
      const lightweight = provider === "azureai-responses";
      const baseUrl = lightweight ? environment.AZURE_OPENAI_BASE_URL : environment.TEXTVED_AZURE_BASE_URL;
      const apiKey = lightweight ? environment.AZURE_OPENAI_API_KEY : environment.TEXTVED_AZURE_API_KEY;
      if (!baseUrl || !apiKey) throw new Error(`Azure credentials are unavailable for ${route}`);
      harness = createAzure({ baseUrl, apiKey, model, tools: {}, maxSteps: 1, maxOutputTokens: 32, timeoutMs: 60_000 });
    }
    const response = await harness.run("Reply with exactly OK.");
    if (!response?.text?.trim()) throw new Error(`Provider returned an empty response for ${route}`);
    results.push({ route, status: "ok" });
  }
  return results;
}

async function main() {
  const config = loadConfig();
  Object.assign(process.env, await loadRuntimeSecrets(config));
  process.stdout.write(`${JSON.stringify(await probeProviders(process.env))}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
