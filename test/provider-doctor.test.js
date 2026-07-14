import test from "node:test";
import assert from "node:assert/strict";
import { probeProviders } from "../src/provider-doctor.js";

test("probes each configured provider route once and rejects missing credentials", async () => {
  const calls = [];
  const environment = {
    FACTORY_MODEL_SCOUT: "azureai-responses/gpt-small",
    FACTORY_MODEL_BUILDER: "bedrock/model-builder",
    FACTORY_MODEL_PLANNER: "bedrock/model-builder",
    FACTORY_MODEL_TESTER: "bedrock/model-builder",
    FACTORY_MODEL_DEBUGGER: "bedrock/model-builder",
    FACTORY_MODEL_REVIEWER: "bedrock/model-builder",
    FACTORY_MODEL_SECURITY: "bedrock/model-builder",
    FACTORY_MODEL_RELEASE: "bedrock/model-builder",
    AZURE_OPENAI_BASE_URL: "https://example.test",
    AZURE_OPENAI_API_KEY: "key",
    AWS_REGION: "us-east-1",
    AWS_ACCESS_KEY_ID: "access",
    AWS_SECRET_ACCESS_KEY: "secret",
  };
  const result = await probeProviders(environment, {
    createAzure: (options) => ({ run: async () => { calls.push(["azure", options.model]); return { text: "OK" }; } }),
    createBedrock: (options) => ({ run: async () => { calls.push(["bedrock", options.model]); return { text: "OK" }; } }),
  });
  assert.deepEqual(calls, [["azure", "gpt-small"], ["bedrock", "model-builder"]]);
  assert.deepEqual(result.map((item) => item.status), ["ok", "ok"]);
  await assert.rejects(() => probeProviders({ ...environment, AZURE_OPENAI_API_KEY: "" }), /credentials are unavailable/);
});
