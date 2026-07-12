import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./process.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractRunCommand(value) {
  const match = value.match(/\[stdout\]\n([\s\S]*?)\n\[stderr\]/);
  return (match?.[1] ?? value).trim();
}

async function command(name, args, options = {}) {
  const result = await run(name, args, { timeoutMs: 180_000, maxOutputBytes: 5_000_000, ...options });
  return result.stdout.trim();
}

export function createOperator(environment = process.env) {
  const resourceGroup = environment.FACTORY_RESOURCE_GROUP ?? "rg-vedant-3569";
  const vm = environment.FACTORY_VM ?? "agent-factory-vm";
  const namespace = environment.FACTORY_SERVICE_BUS ?? "af-4jelq52xdxoty";
  const vault = environment.FACTORY_KEY_VAULT ?? "af4jelq52xdxoty";
  const remote = async (script) => extractRunCommand(await command("az", ["vm", "run-command", "invoke", "--resource-group", resourceGroup, "--name", vm, "--command-id", "RunShellScript", "--scripts", script, "--query", "value[0].message", "--output", "tsv"]));
  const withVault = async (operation) => {
    const ip = await command("curl", ["-fsS", "https://api.ipify.org"]);
    await command("az", ["keyvault", "network-rule", "add", "--name", vault, "--ip-address", `${ip}/32`, "--output", "none"]);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try { return await operation(); } finally {
      await command("az", ["keyvault", "network-rule", "remove", "--name", vault, "--ip-address", `${ip}/32`, "--output", "none"]).catch(() => {});
    }
  };
  return {
    dashboard: async () => JSON.parse(await remote("sudo -u factory env $(xargs < /etc/agent-factory-control.env) node /opt/agent-factory/app/src/dashboard.js --json")),
    logs: async () => remote('journalctl -u agent-factory-control -u agent-factory-worker -u agent-factory-release --since "1 hour ago" --no-pager -n 300'),
    submit: async (repository, objective) => {
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || objective.trim().length < 3) throw new Error("Valid repository and objective are required");
      const output = await command(path.join(root, "bin/factory"), ["submit", repository, objective]);
      const match = output.match(/\{"objectiveId"[\s\S]*?\}/);
      return match ? JSON.parse(match[0]) : { status: "submitted" };
    },
    control: async (action) => {
      if (!["pause", "resume"].includes(action)) throw new Error("Unsupported control action");
      return command(path.join(root, "bin/factory"), [action]);
    },
    capabilities: async () => JSON.parse(await readFile(path.join(root, "config/capabilities.json"), "utf8")),
    config: () => ({ resourceGroup, vm, namespace, vault }),
    listSecrets: async () => withVault(async () => JSON.parse(await command("az", ["keyvault", "secret", "list", "--vault-name", vault, "--query", "[].{name:name,updated:attributes.updated}", "--output", "json"]))),
    setSecret: async (name, value) => withVault(async () => {
      if (!/^[A-Za-z0-9-]{1,127}$/.test(name) || !value) throw new Error("Valid secret name and value are required");
      await command("az", ["keyvault", "secret", "set", "--vault-name", vault, "--name", name, "--value", value, "--output", "none"]);
    }),
    deleteSecret: async (name) => withVault(async () => {
      if (!/^[A-Za-z0-9-]{1,127}$/.test(name)) throw new Error("Invalid secret name");
      await command("az", ["keyvault", "secret", "delete", "--vault-name", vault, "--name", name, "--output", "none"]);
    }),
  };
}
