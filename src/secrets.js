import { DefaultAzureCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";

export async function loadRuntimeSecrets(config, credential = new DefaultAzureCredential()) {
  const client = new SecretClient(config.keyVaultUrl, credential);
  const values = {};
  for (const [environmentName, secretName] of Object.entries(config.secretNames)) {
    const secret = await client.getSecret(secretName);
    if (!secret.value || /[\r\n]/.test(secret.value)) {
      throw new Error(`Key Vault secret ${secretName} is empty or invalid`);
    }
    values[environmentName] = secret.value;
  }
  values.GITHUB_PERSONAL_ACCESS_TOKEN = values.GH_TOKEN;
  return values;
}
